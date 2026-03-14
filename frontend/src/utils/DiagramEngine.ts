const DIAGRAM_COLORS = {
  ink: '#0f172a',
  accent: '#2563eb',
  accentSoft: '#dbeafe',
  warm: '#f59e0b',
  warmSoft: '#fef3c7',
  success: '#059669',
  successSoft: '#d1fae5',
  muted: '#64748b',
  canvas: '#ffffff',
}

const FONT_FAMILY = 1
const DEFAULT_FONT_SIZE = 28
const BOX_WIDTH = 92
const BOX_HEIGHT = 66
const BOX_GAP = 18
const STAGE_DELAY_MS = 800

type Point = { x: number; y: number }

type BinarySearchDiagram = {
  type: 'binary_search'
  array: Array<string | number>
  mid_index: number
  low_index?: number
  high_index?: number
  title?: string
}

type ArrayDiagram = {
  type: 'array'
  values: Array<string | number>
  highlightedIndices?: number[]
  label?: string
}

type TreeNodeValue = string | number
type TreeNode = {
  value: TreeNodeValue
  left?: TreeNode | null
  right?: TreeNode | null
}

type TreeDiagram = {
  type: 'tree'
  root: TreeNode
  title?: string
}

type TriangleDiagram = {
  type: 'triangle'
  labels?: {
    a?: string
    b?: string
    c?: string
  }
  title?: string
}

type LinkedListDiagram = {
  type: 'linked_list'
  values: Array<string | number>
}

type GraphDiagram = {
  type: 'graph'
  nodes: Array<{ id: string; label?: string; x?: number; y?: number }>
  edges: Array<{ from: string; to: string; label?: string }>
}

type FormulaDiagram = {
  type: 'formula'
  expression: string
  label?: string
}

export type DiagramInstruction =
  | BinarySearchDiagram
  | ArrayDiagram
  | TreeDiagram
  | TriangleDiagram
  | LinkedListDiagram
  | GraphDiagram
  | FormulaDiagram

type SceneElement = Record<string, any>

export type DiagramRenderResult = {
  elements: SceneElement[]
  stages: SceneElement[][]
  bounds: { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number }
}

function randomSeed() {
  return Math.floor(Math.random() * 1_000_000)
}

function makeBaseElement(type: string, x: number, y: number, width: number, height: number, overrides: Record<string, any> = {}) {
  return {
    id: crypto.randomUUID(),
    type,
    x,
    y,
    width,
    height,
    strokeColor: DIAGRAM_COLORS.ink,
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2.25,
    strokeStyle: 'solid',
    roughness: 0.4,
    opacity: 100,
    angle: 0,
    seed: randomSeed(),
    version: 1,
    versionNonce: randomSeed(),
    isDeleted: false,
    groupIds: [],
    frameId: null,
    boundElements: null,
    updated: Date.now(),
    link: null,
    locked: false,
    ...overrides,
  }
}

function makeText(x: number, y: number, text: string, fontSize = DEFAULT_FONT_SIZE, color = DIAGRAM_COLORS.ink, textAlign: 'left' | 'center' | 'right' = 'center') {
  const width = Math.max(text.length * fontSize * 0.56, fontSize)
  const height = fontSize * 1.35
  return {
    ...makeBaseElement('text', x, y, width, height, {
      strokeColor: color,
      fontSize,
      fontFamily: FONT_FAMILY,
      text,
      originalText: text,
      textAlign,
      verticalAlign: 'middle',
      lineHeight: 1.25,
      containerId: null,
      autoResize: true,
    }),
  }
}

function makeRectangle(x: number, y: number, width: number, height: number, overrides: Record<string, any> = {}) {
  return makeBaseElement('rectangle', x, y, width, height, overrides)
}

function makeEllipse(x: number, y: number, width: number, height: number, overrides: Record<string, any> = {}) {
  return makeBaseElement('ellipse', x, y, width, height, overrides)
}

function makeLine(x: number, y: number, points: [number, number][], overrides: Record<string, any> = {}) {
  const xs = points.map(([px]) => px)
  const ys = points.map(([, py]) => py)
  const width = Math.max(...xs) - Math.min(...xs) || 1
  const height = Math.max(...ys) - Math.min(...ys) || 1
  return {
    ...makeBaseElement('line', x, y, width, height),
    points,
    lastCommittedPoint: null,
    startBinding: null,
    endBinding: null,
    startArrowhead: null,
    endArrowhead: null,
    ...overrides,
  }
}

function makeArrow(x: number, y: number, points: [number, number][], overrides: Record<string, any> = {}) {
  const xs = points.map(([px]) => px)
  const ys = points.map(([, py]) => py)
  const width = Math.max(...xs) - Math.min(...xs) || 1
  const height = Math.max(...ys) - Math.min(...ys) || 1
  return {
    ...makeBaseElement('arrow', x, y, width, height),
    points,
    lastCommittedPoint: null,
    startBinding: null,
    endBinding: null,
    startArrowhead: null,
    endArrowhead: 'arrow',
    ...overrides,
  }
}

function normalizeStages(stages: SceneElement[][]): DiagramRenderResult {
  const elements = stages.flat()
  const bounds = computeBounds(elements)
  return { elements, stages, bounds }
}

function computeBounds(elements: SceneElement[]) {
  if (!elements.length) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 }
  }

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  for (const element of elements) {
    minX = Math.min(minX, element.x)
    minY = Math.min(minY, element.y)
    maxX = Math.max(maxX, element.x + (element.width || 0))
    maxY = Math.max(maxY, element.y + (element.height || 0))
  }

  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
  }
}

export function rowLayout(count: number, start: Point, itemWidth: number, gap: number) {
  return Array.from({ length: count }, (_, index) => ({
    x: start.x + index * (itemWidth + gap),
    y: start.y,
  }))
}

export function gridLayout(count: number, columns: number, start: Point, cellWidth: number, cellHeight: number, gapX = 24, gapY = 24) {
  return Array.from({ length: count }, (_, index) => {
    const column = index % columns
    const row = Math.floor(index / columns)
    return {
      x: start.x + column * (cellWidth + gapX),
      y: start.y + row * (cellHeight + gapY),
    }
  })
}

export function treeLayout(root: TreeNode, start: Point, levelGap = 120, siblingGap = 96) {
  const positions = new Map<TreeNode, Point>()
  let cursorX = start.x

  function visit(node: TreeNode | null | undefined, depth: number): Point | null {
    if (!node) return null

    const left: Point | null = visit(node.left, depth + 1)
    const currentX = cursorX
    if (!left) {
      cursorX += siblingGap
    }

    const x: number = left ? left.x + siblingGap / 2 : currentX
    const y = start.y + depth * levelGap
    positions.set(node, { x, y })

    const right: Point | null = visit(node.right, depth + 1)
    if (right) {
      const midpoint: number = (positions.get(node.left!)?.x ?? x + siblingGap) + (right.x - (positions.get(node.left!)?.x ?? x)) / 2
      positions.set(node, { x: midpoint, y })
      return { x: midpoint, y }
    }

    return { x, y }
  }

  visit(root, 0)
  return positions
}

function buildArrayCells(values: Array<string | number>, start: Point, highlightedIndices: number[] = []) {
  const positions = rowLayout(values.length, start, BOX_WIDTH, BOX_GAP)
  const highlightSet = new Set(highlightedIndices)
  const boxes: SceneElement[] = []
  const texts: SceneElement[] = []
  const indexLabels: SceneElement[] = []

  values.forEach((value, index) => {
    const pos = positions[index]
    const isHighlighted = highlightSet.has(index)
    boxes.push(
      makeRectangle(pos.x, pos.y, BOX_WIDTH, BOX_HEIGHT, {
        strokeColor: isHighlighted ? DIAGRAM_COLORS.accent : DIAGRAM_COLORS.ink,
        backgroundColor: isHighlighted ? DIAGRAM_COLORS.accentSoft : '#ffffff',
        strokeWidth: isHighlighted ? 3 : 2.25,
      }),
    )
    texts.push(
      makeText(pos.x + BOX_WIDTH / 2 - 10, pos.y + BOX_HEIGHT / 2 - 16, String(value), 30),
    )
    indexLabels.push(
      makeText(pos.x + BOX_WIDTH / 2 - 8, pos.y + BOX_HEIGHT + 12, String(index), 18, DIAGRAM_COLORS.muted),
    )
  })

  return { positions, boxes, texts, indexLabels }
}

export function renderBinarySearchDiagram(diagram: BinarySearchDiagram, origin: Point = { x: 120, y: 140 }): DiagramRenderResult {
  const values = Array.isArray(diagram.array) ? diagram.array : []
  const midIndex = Math.max(0, Math.min(values.length - 1, diagram.mid_index ?? 0))
  const title = makeText(origin.x, origin.y - 86, diagram.title || 'Binary Search', 34, DIAGRAM_COLORS.ink, 'left')
  const subtitle = makeText(origin.x, origin.y - 42, 'Check the middle element first.', 22, DIAGRAM_COLORS.muted, 'left')
  const cells = buildArrayCells(values, origin, [midIndex])
  const midCell = cells.positions[midIndex] ?? origin
  const arrowX = midCell.x + BOX_WIDTH / 2
  const arrowY = origin.y + BOX_HEIGHT + 74

  const pointerArrow = makeArrow(arrowX, arrowY, [
    [0, 0],
    [0, -56],
  ], {
    strokeColor: DIAGRAM_COLORS.warm,
    strokeWidth: 3,
  })
  const pointerLabel = makeText(arrowX - 18, arrowY + 10, 'mid', 22, DIAGRAM_COLORS.warm)

  const rangeGuides: SceneElement[] = []
  if (typeof diagram.low_index === 'number' && cells.positions[diagram.low_index]) {
    rangeGuides.push(makeText(cells.positions[diagram.low_index].x + 24, origin.y - 34, 'low', 18, DIAGRAM_COLORS.success))
  }
  if (typeof diagram.high_index === 'number' && cells.positions[diagram.high_index]) {
    rangeGuides.push(makeText(cells.positions[diagram.high_index].x + 24, origin.y - 34, 'high', 18, DIAGRAM_COLORS.success))
  }

  return normalizeStages([
    [title, subtitle],
    [...cells.boxes],
    [...cells.texts, ...cells.indexLabels],
    [...rangeGuides, pointerArrow, pointerLabel],
  ])
}

export function renderArrayDiagram(diagram: ArrayDiagram, origin: Point = { x: 120, y: 160 }): DiagramRenderResult {
  const label = diagram.label ? [makeText(origin.x, origin.y - 64, diagram.label, 32, DIAGRAM_COLORS.ink, 'left')] : []
  const cells = buildArrayCells(diagram.values || [], origin, diagram.highlightedIndices || [])
  return normalizeStages([
    label,
    cells.boxes,
    [...cells.texts, ...cells.indexLabels],
  ])
}

export function renderTreeDiagram(diagram: TreeDiagram, origin: Point = { x: 280, y: 140 }): DiagramRenderResult {
  const positions = treeLayout(diagram.root, origin)
  const nodes: SceneElement[] = []
  const labels: SceneElement[] = []
  const edges: SceneElement[] = []
  const title = diagram.title ? [makeText(origin.x - 180, origin.y - 80, diagram.title, 32, DIAGRAM_COLORS.ink, 'left')] : []

  function visit(node: TreeNode | null | undefined) {
    if (!node) return
    const point = positions.get(node)
    if (!point) return

    if (node.left) {
      const leftPoint = positions.get(node.left)
      if (leftPoint) {
        edges.push(makeArrow(point.x, point.y, [[0, 0], [leftPoint.x - point.x, leftPoint.y - point.y]], {
          strokeColor: DIAGRAM_COLORS.muted,
          strokeWidth: 2.25,
        }))
      }
    }
    if (node.right) {
      const rightPoint = positions.get(node.right)
      if (rightPoint) {
        edges.push(makeArrow(point.x, point.y, [[0, 0], [rightPoint.x - point.x, rightPoint.y - point.y]], {
          strokeColor: DIAGRAM_COLORS.muted,
          strokeWidth: 2.25,
        }))
      }
    }

    nodes.push(makeEllipse(point.x - 34, point.y - 34, 68, 68, {
      strokeColor: DIAGRAM_COLORS.accent,
      backgroundColor: DIAGRAM_COLORS.accentSoft,
      strokeWidth: 2.5,
    }))
    labels.push(makeText(point.x - 12, point.y - 16, String(node.value), 26))

    visit(node.left)
    visit(node.right)
  }

  visit(diagram.root)

  return normalizeStages([
    title,
    edges,
    [...nodes, ...labels],
  ])
}

export function renderTriangleDiagram(diagram: TriangleDiagram, origin: Point = { x: 160, y: 180 }): DiagramRenderResult {
  const title = diagram.title ? [makeText(origin.x - 20, origin.y - 96, diagram.title, 32, DIAGRAM_COLORS.ink, 'left')] : []
  const triangle = [
    makeLine(origin.x, origin.y + 120, [[0, 0], [220, 0]], { strokeColor: DIAGRAM_COLORS.accent, strokeWidth: 3 }),
    makeLine(origin.x, origin.y + 120, [[0, 0], [0, -140]], { strokeColor: DIAGRAM_COLORS.accent, strokeWidth: 3 }),
    makeLine(origin.x, origin.y - 20, [[0, 0], [220, 140]], { strokeColor: DIAGRAM_COLORS.accent, strokeWidth: 3 }),
  ]
  const labels = [
    makeText(origin.x + 92, origin.y + 128, diagram.labels?.a || 'a', 24, DIAGRAM_COLORS.muted),
    makeText(origin.x - 24, origin.y + 38, diagram.labels?.b || 'b', 24, DIAGRAM_COLORS.muted),
    makeText(origin.x + 112, origin.y + 28, diagram.labels?.c || 'c', 24, DIAGRAM_COLORS.warm),
  ]

  return normalizeStages([
    title,
    triangle,
    labels,
  ])
}

function renderLinkedListDiagram(diagram: LinkedListDiagram, origin: Point = { x: 120, y: 160 }): DiagramRenderResult {
  const cells = buildArrayCells(diagram.values || [], origin)
  const arrows = cells.positions.slice(0, -1).map((pos) =>
    makeArrow(pos.x + BOX_WIDTH, pos.y + BOX_HEIGHT / 2, [[0, 0], [BOX_GAP, 0]], {
      strokeColor: DIAGRAM_COLORS.warm,
      strokeWidth: 2.5,
    }),
  )
  return normalizeStages([
    cells.boxes,
    cells.texts,
    arrows,
  ])
}

function renderGraphDiagram(diagram: GraphDiagram, origin: Point = { x: 180, y: 160 }): DiagramRenderResult {
  const fallbackPositions = gridLayout(diagram.nodes.length, 3, origin, 140, 100, 36, 56)
  const nodeMap = new Map<string, Point>()
  const nodes: SceneElement[] = []
  const labels: SceneElement[] = []
  const edges: SceneElement[] = []

  diagram.nodes.forEach((node, index) => {
    const point = {
      x: node.x ?? fallbackPositions[index]?.x ?? origin.x,
      y: node.y ?? fallbackPositions[index]?.y ?? origin.y,
    }
    nodeMap.set(node.id, point)
    nodes.push(makeEllipse(point.x, point.y, 72, 72, {
      strokeColor: DIAGRAM_COLORS.success,
      backgroundColor: DIAGRAM_COLORS.successSoft,
      strokeWidth: 2.5,
    }))
    labels.push(makeText(point.x + 18, point.y + 20, node.label || node.id, 22))
  })

  diagram.edges.forEach((edge) => {
    const from = nodeMap.get(edge.from)
    const to = nodeMap.get(edge.to)
    if (!from || !to) return
    edges.push(makeArrow(from.x + 36, from.y + 36, [[0, 0], [to.x - from.x, to.y - from.y]], {
      strokeColor: DIAGRAM_COLORS.muted,
      strokeWidth: 2.25,
    }))
    if (edge.label) {
      labels.push(makeText((from.x + to.x) / 2 + 8, (from.y + to.y) / 2 - 12, edge.label, 18, DIAGRAM_COLORS.warm))
    }
  })

  return normalizeStages([
    edges,
    [...nodes, ...labels],
  ])
}

function renderFormulaDiagram(diagram: FormulaDiagram, origin: Point = { x: 140, y: 180 }): DiagramRenderResult {
  return normalizeStages([
    diagram.label ? [makeText(origin.x, origin.y - 54, diagram.label, 26, DIAGRAM_COLORS.muted, 'left')] : [],
    [makeText(origin.x, origin.y, diagram.expression, 42, DIAGRAM_COLORS.ink, 'left')],
  ])
}

export function renderDiagram(diagram: DiagramInstruction, origin: Point = { x: 120, y: 140 }): DiagramRenderResult {
  if (!diagram || typeof diagram !== 'object' || !('type' in diagram)) {
    return normalizeStages([])
  }

  switch (diagram.type) {
    case 'binary_search':
      return renderBinarySearchDiagram(diagram, origin)
    case 'array':
      return renderArrayDiagram(diagram, origin)
    case 'tree':
      return renderTreeDiagram(diagram, origin)
    case 'triangle':
      return renderTriangleDiagram(diagram, origin)
    case 'linked_list':
      return renderLinkedListDiagram(diagram, origin)
    case 'graph':
      return renderGraphDiagram(diagram, origin)
    case 'formula':
      return renderFormulaDiagram(diagram, origin)
    default:
      return normalizeStages([])
  }
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function mergeSceneElements(existing: SceneElement[], incoming: SceneElement[]) {
  return [...existing, ...incoming]
}

export async function animateDiagram(diagram: DiagramInstruction, excalidrawAPI: any, options: { reset?: boolean; duration?: number } = {}) {
  if (!excalidrawAPI || !diagram) return

  const rendered = renderDiagram(diagram)

  if (options.reset !== false) {
    excalidrawAPI.updateScene({
      elements: [],
      appState: {
        viewBackgroundColor: DIAGRAM_COLORS.canvas,
      },
    })
  }

  for (const stage of rendered.stages) {
    if (!stage.length) continue
    const existing = excalidrawAPI.getSceneElements()
    excalidrawAPI.updateScene({
      elements: mergeSceneElements(existing, stage),
      appState: {
        viewBackgroundColor: DIAGRAM_COLORS.canvas,
      },
    })
    excalidrawAPI.scrollToContent(excalidrawAPI.getSceneElements(), {
      fitToContent: true,
      animate: true,
      duration: options.duration ?? 420,
      minZoom: 0.55,
      maxZoom: 1.35,
    })
    await wait(STAGE_DELAY_MS)
  }
}

export function applyViewportToDiagram(excalidrawAPI: any) {
  if (!excalidrawAPI) return
  excalidrawAPI.scrollToContent(excalidrawAPI.getSceneElements(), {
    fitToContent: true,
    animate: true,
    duration: 420,
    minZoom: 0.5,
    maxZoom: 1.35,
  })
}

