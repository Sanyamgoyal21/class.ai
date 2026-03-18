const COLORS = {
  ink: '#0f172a',
  muted: '#64748b',
  accent: '#2563eb',
  accentSoft: '#dbeafe',
  warm: '#f59e0b',
  warmSoft: '#fef3c7',
  success: '#059669',
  successSoft: '#d1fae5',
  danger: '#dc2626',
  dangerSoft: '#fee2e2',
  violet: '#7c3aed',
  violetSoft: '#ede9fe',
  slateSoft: '#e2e8f0',
  canvas: '#ffffff',
}

const FONT_FAMILY = 1
const ARRAY_CELL_WIDTH = 88
const ARRAY_CELL_HEIGHT = 60
const ARRAY_GAP = 16
const MATRIX_CELL_SIZE = 46
const STAGE_DELAY_MS = 800
const FAST_DELAY_MS = 420
const DEFAULT_CODE_FONT = 18

export type Primitive = string | number
type Point = { x: number; y: number }
type SceneElement = Record<string, any>

type ArrayStep = { type: 'array'; values: Primitive[]; label?: string }
type DpArrayStep = { type: 'dp_array'; values: Primitive[]; label?: string }
type CompareStep = { type: 'compare'; i: number; j: number }
type UpdateStep = { type: 'update'; index: number; value: Primitive }
type HighlightIndexStep = { type: 'highlight_index'; index: number; row?: 'array' | 'dp' }
type ArrowStep = { type: 'arrow'; from?: string; to?: string; label?: string }
type AnnotationStep = { type: 'annotation'; text: string }
type CodeStep = { type: 'code'; text: string }
type ResultStep = { type: 'result'; text: string }
type SwapStep = { type: 'swap'; i: number; j: number }
type GraphStep = {
  type: 'graph'
  nodes: Array<{ id: string; label?: string; x?: number; y?: number }>
  edges: Array<{ from: string; to: string; label?: string }>
}
type VisitNodeStep = { type: 'visit_node'; node: string }
type FrontierStep = { type: 'frontier'; label: string; values: string[] }
type MatrixStep = { type: 'matrix'; values: Primitive[][]; label?: string }
type MatrixUpdateStep = { type: 'matrix_update'; row: number; col: number; value: Primitive }
type HighlightCellStep = { type: 'highlight_cell'; row: number; col: number }

export type AlgorithmStep =
  | ArrayStep
  | DpArrayStep
  | CompareStep
  | UpdateStep
  | HighlightIndexStep
  | ArrowStep
  | AnnotationStep
  | CodeStep
  | ResultStep
  | SwapStep
  | GraphStep
  | VisitNodeStep
  | FrontierStep
  | MatrixStep
  | MatrixUpdateStep
  | HighlightCellStep

type BaseInstruction = {
  type: string
  title?: string
  code?: string
  steps?: AlgorithmStep[]
}

export type LisAlgorithmInstruction = BaseInstruction & {
  type: 'lis_dp'
  array?: Primitive[]
}

export type BinarySearchInstruction = BaseInstruction & {
  type: 'binary_search_walkthrough'
  array?: Primitive[]
  target?: Primitive
}

export type BubbleSortInstruction = BaseInstruction & {
  type: 'bubble_sort'
  array?: Primitive[]
}

export type InsertionSortInstruction = BaseInstruction & {
  type: 'insertion_sort'
  array?: Primitive[]
}

type GraphData = {
  nodes: Array<{ id: string; label?: string; x?: number; y?: number }>
  edges: Array<{ from: string; to: string; label?: string }>
}

export type GraphTraversalInstruction = BaseInstruction & {
  type: 'bfs' | 'dfs'
  graph?: GraphData
  start?: string
}

export type KnapsackInstruction = BaseInstruction & {
  type: 'knapsack_dp'
  weights?: number[]
  values?: number[]
  capacity?: number
}

export type AlgorithmInstruction =
  | LisAlgorithmInstruction
  | BinarySearchInstruction
  | BubbleSortInstruction
  | InsertionSortInstruction
  | GraphTraversalInstruction
  | KnapsackInstruction

export type BoardState = {
  title: string
  inputArray: Primitive[]
  arrayLabel?: string
  dpArray: Primitive[]
  dpLabel?: string
  highlighted: { array: number[]; dp: number[] }
  activeComparison: { i: number; j: number } | null
  annotations: string[]
  resultText: string
  codeBlock: string
  graph: GraphData | null
  visitedNodes: Set<string>
  activeNode: string | null
  frontier: { label: string; values: string[] } | null
  matrix: Primitive[][]
  matrixLabel?: string
  highlightedCell: { row: number; col: number } | null
  updatedMatrixCell: { row: number; col: number } | null
  headerNote: string
}


function randomSeed() {
  return Math.floor(Math.random() * 1_000_000)
}

function baseElement(type: string, x: number, y: number, width: number, height: number, overrides: Record<string, any> = {}) {
  return {
    id: crypto.randomUUID(),
    type,
    x,
    y,
    width,
    height,
    strokeColor: COLORS.ink,
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
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

function textElement(x: number, y: number, text: string, fontSize = 24, color = COLORS.ink, textAlign: 'left' | 'center' | 'right' = 'left') {
  const width = Math.max(fontSize, text.split('\n').reduce((max, line) => Math.max(max, line.length * fontSize * 0.54), 0))
  const height = Math.max(fontSize * 1.25, text.split('\n').length * fontSize * 1.22)
  return baseElement('text', x, y, width, height, {
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
  })
}

function rectangleElement(x: number, y: number, width: number, height: number, overrides: Record<string, any> = {}) {
  return baseElement('rectangle', x, y, width, height, overrides)
}

function ellipseElement(x: number, y: number, width: number, height: number, overrides: Record<string, any> = {}) {
  return baseElement('ellipse', x, y, width, height, overrides)
}

function arrowElement(x: number, y: number, points: [number, number][], overrides: Record<string, any> = {}) {
  const xs = points.map(([px]) => px)
  const ys = points.map(([, py]) => py)
  return {
    ...baseElement('arrow', x, y, Math.max(...xs) - Math.min(...xs) || 1, Math.max(...ys) - Math.min(...ys) || 1),
    points,
    lastCommittedPoint: null,
    startBinding: null,
    endBinding: null,
    startArrowhead: null,
    endArrowhead: 'arrow',
    ...overrides,
  }
}

function lineElement(x: number, y: number, points: [number, number][], overrides: Record<string, any> = {}) {
  const xs = points.map(([px]) => px)
  const ys = points.map(([, py]) => py)
  return {
    ...baseElement('line', x, y, Math.max(...xs) - Math.min(...xs) || 1, Math.max(...ys) - Math.min(...ys) || 1),
    points,
    lastCommittedPoint: null,
    startBinding: null,
    endBinding: null,
    startArrowhead: null,
    endArrowhead: null,
    ...overrides,
  }
}

function cloneState(state: BoardState): BoardState {
  return {
    ...state,
    inputArray: [...state.inputArray],
    dpArray: [...state.dpArray],
    highlighted: {
      array: [...state.highlighted.array],
      dp: [...state.highlighted.dp],
    },
    annotations: [...state.annotations],
    visitedNodes: new Set(state.visitedNodes),
    frontier: state.frontier ? { label: state.frontier.label, values: [...state.frontier.values] } : null,
    graph: state.graph
      ? {
          nodes: state.graph.nodes.map((node) => ({ ...node })),
          edges: state.graph.edges.map((edge) => ({ ...edge })),
        }
      : null,
    matrix: state.matrix.map((row) => [...row]),
  }
}

function createBoardState(instruction: AlgorithmInstruction): BoardState {
  return {
    title: instruction.title || readableTitle(instruction.type),
    inputArray: [],
    arrayLabel: 'input',
    dpArray: [],
    dpLabel: 'dp',
    highlighted: { array: [], dp: [] },
    activeComparison: null,
    annotations: [],
    resultText: '',
    codeBlock: instruction.code || '',
    graph: null,
    visitedNodes: new Set(),
    activeNode: null,
    frontier: null,
    matrix: [],
    matrixLabel: 'dp',
    highlightedCell: null,
    updatedMatrixCell: null,
    headerNote: '',
  }
}

function readableTitle(type: string) {
  return type
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

export const layout = {
  arrayRow(origin: Point = { x: 110, y: 180 }) {
    return origin
  },
  dpRow(origin: Point = { x: 110, y: 290 }) {
    return origin
  },
  annotation(origin: Point = { x: 110, y: 410 }, index = 0) {
    return { x: origin.x, y: origin.y + index * 42 }
  },
  codeBlock(origin: Point = { x: 980, y: 110 }) {
    return origin
  },
}

function rowLayout(count: number, start: Point, width = ARRAY_CELL_WIDTH, gap = ARRAY_GAP) {
  return Array.from({ length: count }, (_, index) => ({
    x: start.x + index * (width + gap),
    y: start.y,
  }))
}

function graphLayout(nodes: GraphData['nodes'], origin: Point = { x: 190, y: 520 }) {
  const fallback = [
    { x: origin.x, y: origin.y },
    { x: origin.x + 170, y: origin.y - 95 },
    { x: origin.x + 170, y: origin.y + 95 },
    { x: origin.x + 340, y: origin.y - 140 },
    { x: origin.x + 340, y: origin.y + 140 },
    { x: origin.x + 510, y: origin.y },
  ]
  const positions = new Map<string, Point>()
  nodes.forEach((node, index) => {
    positions.set(node.id, {
      x: node.x ?? fallback[index % fallback.length].x + Math.floor(index / fallback.length) * 120,
      y: node.y ?? fallback[index % fallback.length].y,
    })
  })
  return positions
}

function adjacencyFromGraph(graph: GraphData) {
  const adjacency = new Map<string, string[]>()
  graph.nodes.forEach((node) => adjacency.set(node.id, []))
  graph.edges.forEach((edge) => {
    adjacency.get(edge.from)?.push(edge.to)
  })
  return adjacency
}

function asNumber(value: Primitive) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function createLisSteps(values: Primitive[], codeText: string): AlgorithmStep[] {
  const steps: AlgorithmStep[] = [
    { type: 'array', values, label: 'nums' },
    { type: 'dp_array', values: values.map(() => 1), label: 'dp' },
    { type: 'annotation', text: 'dp[i] = longest increasing subsequence ending at i' },
    { type: 'code', text: codeText },
  ]
  const dp = values.map(() => 1)
  let best = 1

  for (let i = 1; i < values.length; i += 1) {
    steps.push({ type: 'highlight_index', index: i, row: 'array' })
    for (let j = 0; j < i; j += 1) {
      steps.push({ type: 'compare', i, j })
      if (asNumber(values[j]) < asNumber(values[i]) && dp[j] + 1 > dp[i]) {
        dp[i] = dp[j] + 1
        best = Math.max(best, dp[i])
        steps.push({ type: 'update', index: i, value: dp[i] })
      }
    }
  }

  steps.push({ type: 'result', text: `LIS length = ${best}` })
  return steps
}

function createBinarySearchSteps(values: Primitive[], target: Primitive, codeText: string): AlgorithmStep[] {
  const steps: AlgorithmStep[] = [
    { type: 'array', values, label: 'sorted array' },
    { type: 'annotation', text: `We search for ${target} by repeatedly checking the middle.` },
    { type: 'code', text: codeText },
  ]

  let low = 0
  let high = values.length - 1
  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    steps.push({ type: 'highlight_index', index: low, row: 'array' })
    steps.push({ type: 'highlight_index', index: high, row: 'array' })
    steps.push({ type: 'compare', i: mid, j: low })
    steps.push({ type: 'annotation', text: `mid = ${mid}, value = ${values[mid]}` })

    const midValue = asNumber(values[mid])
    const targetValue = asNumber(target)
    if (midValue === targetValue) {
      steps.push({ type: 'result', text: `Found ${target} at index ${mid}` })
      return steps
    }
    if (midValue < targetValue) {
      steps.push({ type: 'annotation', text: `${values[mid]} is too small, so move right.` })
      low = mid + 1
    } else {
      steps.push({ type: 'annotation', text: `${values[mid]} is too large, so move left.` })
      high = mid - 1
    }
  }

  steps.push({ type: 'result', text: `${target} is not in the array.` })
  return steps
}

function createBubbleSortSteps(values: Primitive[], codeText: string): AlgorithmStep[] {
  const arr = [...values]
  const steps: AlgorithmStep[] = [
    { type: 'array', values: arr, label: 'array' },
    { type: 'annotation', text: 'Bubble sort repeatedly swaps adjacent values that are out of order.' },
    { type: 'code', text: codeText },
  ]

  for (let i = 0; i < arr.length - 1; i += 1) {
    for (let j = 0; j < arr.length - i - 1; j += 1) {
      steps.push({ type: 'compare', i: j, j: j + 1 })
      if (asNumber(arr[j]) > asNumber(arr[j + 1])) {
        ;[arr[j], arr[j + 1]] = [arr[j + 1], arr[j]]
        steps.push({ type: 'swap', i: j, j: j + 1 })
      }
    }
    steps.push({ type: 'annotation', text: `Pass ${i + 1} locks the largest remaining value at the end.` })
  }

  steps.push({ type: 'result', text: `Sorted array = [${arr.join(', ')}]` })
  return steps
}

function createInsertionSortSteps(values: Primitive[], codeText: string): AlgorithmStep[] {
  const arr = [...values]
  const steps: AlgorithmStep[] = [
    { type: 'array', values: arr, label: 'array' },
    { type: 'annotation', text: 'Insertion sort grows a sorted prefix one element at a time.' },
    { type: 'code', text: codeText },
  ]

  for (let i = 1; i < arr.length; i += 1) {
    let j = i
    steps.push({ type: 'highlight_index', index: i, row: 'array' })
    while (j > 0) {
      steps.push({ type: 'compare', i: j - 1, j })
      if (asNumber(arr[j - 1]) <= asNumber(arr[j])) break
      ;[arr[j - 1], arr[j]] = [arr[j], arr[j - 1]]
      steps.push({ type: 'swap', i: j - 1, j })
      j -= 1
    }
    steps.push({ type: 'annotation', text: `Element at index ${i} is inserted into the sorted prefix.` })
  }

  steps.push({ type: 'result', text: `Sorted array = [${arr.join(', ')}]` })
  return steps
}

function createTraversalSteps(type: 'bfs' | 'dfs', graph: GraphData, start: string, codeText: string): AlgorithmStep[] {
  const adjacency = adjacencyFromGraph(graph)
  const steps: AlgorithmStep[] = [
    { type: 'graph', nodes: graph.nodes, edges: graph.edges },
    { type: 'annotation', text: `${type.toUpperCase()} explores nodes in a clear traversal order.` },
    { type: 'code', text: codeText },
  ]

  const order: string[] = []

  if (type === 'bfs') {
    const queue = [start]
    const seen = new Set([start])
    while (queue.length) {
      steps.push({ type: 'frontier', label: 'queue', values: [...queue] })
      const node = queue.shift()!
      order.push(node)
      steps.push({ type: 'visit_node', node })
      for (const next of adjacency.get(node) || []) {
        if (!seen.has(next)) {
          seen.add(next)
          queue.push(next)
        }
      }
    }
  } else {
    const stack = [start]
    const seen = new Set<string>()
    while (stack.length) {
      steps.push({ type: 'frontier', label: 'stack', values: [...stack] })
      const node = stack.pop()!
      if (seen.has(node)) continue
      seen.add(node)
      order.push(node)
      steps.push({ type: 'visit_node', node })
      const neighbors = [...(adjacency.get(node) || [])].reverse()
      neighbors.forEach((next) => {
        if (!seen.has(next)) stack.push(next)
      })
    }
  }

  steps.push({ type: 'result', text: `${type.toUpperCase()} order = ${order.join(' -> ')}` })
  return steps
}

function createKnapsackSteps(weights: number[], values: number[], capacity: number, codeText: string): AlgorithmStep[] {
  const rows = weights.length + 1
  const cols = capacity + 1
  const matrix = Array.from({ length: rows }, () => Array.from({ length: cols }, () => 0))
  const steps: AlgorithmStep[] = [
    { type: 'annotation', text: 'dp[i][cap] stores the best value using the first i items with capacity cap.' },
    { type: 'code', text: codeText },
    { type: 'matrix', values: matrix.map((row) => [...row]), label: 'dp' },
  ]

  for (let i = 1; i <= weights.length; i += 1) {
    for (let cap = 0; cap <= capacity; cap += 1) {
      steps.push({ type: 'highlight_cell', row: i, col: cap })
      matrix[i][cap] = matrix[i - 1][cap]
      if (weights[i - 1] <= cap) {
        matrix[i][cap] = Math.max(matrix[i][cap], values[i - 1] + matrix[i - 1][cap - weights[i - 1]])
      }
      steps.push({ type: 'matrix_update', row: i, col: cap, value: matrix[i][cap] })
    }
  }

  steps.push({ type: 'result', text: `Best value = ${matrix[weights.length][capacity]}` })
  return steps
}

export function normalizeInstruction(instruction: AlgorithmInstruction): Required<AlgorithmInstruction> {
  const title = instruction.title || readableTitle(instruction.type)
  const code = instruction.code || ''

  if (instruction.steps?.length) {
    return { ...instruction, title, code, steps: instruction.steps } as Required<AlgorithmInstruction>
  }

  switch (instruction.type) {
    case 'lis_dp': {
      const array = instruction.array?.length ? instruction.array : []
      const steps = array.length ? createLisSteps(array, code) : []
      return { ...instruction, title, code, array, steps } as Required<AlgorithmInstruction>
    }
    case 'binary_search_walkthrough': {
      const array = instruction.array?.length ? instruction.array : []
      const target = instruction.target ?? ''
      const steps = array.length && target !== '' ? createBinarySearchSteps(array, target, code) : []
      return { ...instruction, title, code, array, target, steps } as Required<AlgorithmInstruction>
    }
    case 'bubble_sort': {
      const array = instruction.array?.length ? instruction.array : []
      const steps = array.length ? createBubbleSortSteps(array, code) : []
      return { ...instruction, title, code, array, steps } as Required<AlgorithmInstruction>
    }
    case 'insertion_sort': {
      const array = instruction.array?.length ? instruction.array : []
      const steps = array.length ? createInsertionSortSteps(array, code) : []
      return { ...instruction, title, code, array, steps } as Required<AlgorithmInstruction>
    }
    case 'bfs':
    case 'dfs': {
      const graph = instruction.graph?.nodes?.length ? instruction.graph : { nodes: [], edges: [] }
      const start = instruction.start || graph.nodes[0]?.id || ''
      const steps = graph.nodes.length && start ? createTraversalSteps(instruction.type, graph, start, code) : []
      return { ...instruction, title, code, graph, start, steps } as Required<AlgorithmInstruction>
    }
    case 'knapsack_dp': {
      const weights = instruction.weights?.length ? instruction.weights : []
      const values = instruction.values?.length ? instruction.values : []
      const capacity = typeof instruction.capacity === 'number' ? instruction.capacity : 0
      const steps = weights.length && values.length ? createKnapsackSteps(weights, values, capacity, code) : []
      return { ...instruction, title, code, weights, values, capacity, steps } as Required<AlgorithmInstruction>
    }
    default:
      return { ...instruction, title, code, steps: [] } as Required<AlgorithmInstruction>
  }
}

function renderArrayRow(values: Primitive[], origin: Point, label: string | undefined, highlighted: number[], updatedIndex: number | null = null) {
  const positions = rowLayout(values.length, origin)
  const highlightSet = new Set(highlighted)
  const elements: SceneElement[] = []

  if (label) {
    elements.push(textElement(origin.x - 78, origin.y + 14, label, 24, COLORS.muted))
  }

  values.forEach((value, index) => {
    const pos = positions[index]
    const isHighlighted = highlightSet.has(index)
    const isUpdated = updatedIndex === index
    elements.push(
      rectangleElement(pos.x, pos.y, ARRAY_CELL_WIDTH, ARRAY_CELL_HEIGHT, {
        strokeColor: isUpdated ? COLORS.success : isHighlighted ? COLORS.accent : COLORS.ink,
        backgroundColor: isUpdated ? COLORS.successSoft : isHighlighted ? COLORS.accentSoft : '#ffffff',
        strokeWidth: isUpdated || isHighlighted ? 3 : 2,
      }),
    )
    elements.push(textElement(pos.x + ARRAY_CELL_WIDTH / 2 - 14, pos.y + 14, String(value), 28, COLORS.ink, 'center'))
    elements.push(textElement(pos.x + ARRAY_CELL_WIDTH / 2 - 7, pos.y + ARRAY_CELL_HEIGHT + 10, String(index), 16, COLORS.muted, 'center'))
  })

  return { elements, positions }
}

function renderGraph(state: BoardState) {
  if (!state.graph) return { elements: [], positions: new Map<string, Point>() }
  const positions = graphLayout(state.graph.nodes)
  const elements: SceneElement[] = []

  state.graph.edges.forEach((edge) => {
    const from = positions.get(edge.from)
    const to = positions.get(edge.to)
    if (!from || !to) return
    elements.push(
      arrowElement(from.x + 34, from.y + 34, [[0, 0], [to.x - from.x, to.y - from.y]], {
        strokeColor: COLORS.slateSoft,
        strokeWidth: 2.2,
      }),
    )
    if (edge.label) {
      elements.push(textElement((from.x + to.x) / 2 + 10, (from.y + to.y) / 2 - 10, edge.label, 16, COLORS.warm))
    }
  })

  state.graph.nodes.forEach((node) => {
    const point = positions.get(node.id)!
    const isVisited = state.visitedNodes.has(node.id)
    const isActive = state.activeNode === node.id
    elements.push(
      ellipseElement(point.x, point.y, 72, 72, {
        strokeColor: isActive ? COLORS.warm : isVisited ? COLORS.success : COLORS.accent,
        backgroundColor: isActive ? COLORS.warmSoft : isVisited ? COLORS.successSoft : COLORS.accentSoft,
        strokeWidth: isActive || isVisited ? 3 : 2.5,
      }),
    )
    elements.push(textElement(point.x + 18, point.y + 20, node.label || node.id, 24, COLORS.ink))
  })

  return { elements, positions }
}

function renderMatrix(state: BoardState, origin: Point = { x: 110, y: 650 }) {
  if (!state.matrix.length) return []
  const elements: SceneElement[] = [textElement(origin.x - 66, origin.y + 10, state.matrixLabel || 'dp', 24, COLORS.muted)]

  state.matrix.forEach((row, rowIndex) => {
    row.forEach((value, colIndex) => {
      const x = origin.x + colIndex * (MATRIX_CELL_SIZE + 10)
      const y = origin.y + rowIndex * (MATRIX_CELL_SIZE + 10)
      const isHighlighted = state.highlightedCell?.row === rowIndex && state.highlightedCell?.col === colIndex
      const isUpdated = state.updatedMatrixCell?.row === rowIndex && state.updatedMatrixCell?.col === colIndex
      elements.push(
        rectangleElement(x, y, MATRIX_CELL_SIZE, MATRIX_CELL_SIZE, {
          strokeColor: isUpdated ? COLORS.success : isHighlighted ? COLORS.warm : COLORS.ink,
          backgroundColor: isUpdated ? COLORS.successSoft : isHighlighted ? COLORS.warmSoft : '#ffffff',
          strokeWidth: isUpdated || isHighlighted ? 2.8 : 1.8,
        }),
      )
      elements.push(textElement(x + 12, y + 10, String(value), 18, COLORS.ink))
    })
  })

  return elements
}

export function renderAlgorithmFrame(state: BoardState) {
  const elements: SceneElement[] = []
  elements.push(textElement(110, 70, state.title, 40, COLORS.ink))
  if (state.headerNote) {
    elements.push(textElement(110, 118, state.headerNote, 20, COLORS.muted))
  }

  const arrayRow = state.inputArray.length ? renderArrayRow(state.inputArray, layout.arrayRow(), state.arrayLabel, state.highlighted.array) : null
  if (arrayRow) elements.push(...arrayRow.elements)

  const dpRow = state.dpArray.length ? renderArrayRow(state.dpArray, layout.dpRow(), state.dpLabel, state.highlighted.dp, state.highlighted.dp[0] ?? null) : null
  if (dpRow) elements.push(...dpRow.elements)

  if (state.activeComparison && arrayRow) {
    const first = arrayRow.positions[state.activeComparison.j]
    const second = arrayRow.positions[state.activeComparison.i]
    if (first && second) {
      const startX = first.x + ARRAY_CELL_WIDTH / 2
      const startY = first.y - 12
      const endX = second.x + ARRAY_CELL_WIDTH / 2
      const span = endX - startX
      elements.push(
        arrowElement(startX, startY, [[0, 0], [span / 2, -36], [span, 0]], {
          strokeColor: COLORS.warm,
          strokeWidth: 3,
        }),
      )
      elements.push(textElement((startX + endX) / 2 - 30, startY - 50, 'compare', 18, COLORS.warm))
    }
  }

  state.annotations.slice(-6).forEach((note, index) => {
    const point = layout.annotation({ x: 110, y: state.dpArray.length ? 410 : 320 }, index)
    elements.push(textElement(point.x, point.y, `• ${note}`, 22, COLORS.ink))
  })

  if (state.resultText) {
    elements.push(
      rectangleElement(110, 560, 360, 64, {
        strokeColor: COLORS.violet,
        backgroundColor: COLORS.violetSoft,
        strokeWidth: 3,
      }),
    )
    elements.push(textElement(136, 578, state.resultText, 24, COLORS.violet))
  }

  if (state.frontier) {
    elements.push(
      rectangleElement(110, 430, 300, 54, {
        strokeColor: COLORS.warm,
        backgroundColor: COLORS.warmSoft,
      }),
    )
    elements.push(textElement(128, 446, `${state.frontier.label}: ${state.frontier.values.join(', ')}`, 20, COLORS.warm))
  }

  if (state.codeBlock) {
    elements.push(
      rectangleElement(980, 110, 430, 260, {
        strokeColor: COLORS.slateSoft,
        backgroundColor: '#ffffff',
        strokeWidth: 2,
      }),
    )
    elements.push(textElement(1006, 130, 'Algorithm', 24, COLORS.muted))
    elements.push(textElement(1006, 170, state.codeBlock, DEFAULT_CODE_FONT, COLORS.ink))
  }

  const graph = renderGraph(state)
  elements.push(...graph.elements)
  elements.push(...renderMatrix(state))

  return {
    elements,
    bounds: computeBounds(elements),
  }
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
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY }
}

function applyStep(state: BoardState, step: AlgorithmStep) {
  const next = cloneState(state)
  next.activeComparison = null
  next.highlighted.array = []
  next.highlighted.dp = []
  next.highlightedCell = null
  next.updatedMatrixCell = null

  switch (step.type) {
    case 'array':
      next.inputArray = [...step.values]
      next.arrayLabel = step.label || next.arrayLabel
      next.headerNote = 'Step-by-step lecture board'
      break
    case 'dp_array':
      next.dpArray = [...step.values]
      next.dpLabel = step.label || 'dp'
      break
    case 'compare':
      next.activeComparison = { i: step.i, j: step.j }
      next.highlighted.array = [step.i, step.j]
      break
    case 'update':
      next.dpArray[step.index] = step.value
      next.highlighted.dp = [step.index]
      break
    case 'highlight_index':
      next.highlighted[step.row === 'dp' ? 'dp' : 'array'] = [step.index]
      break
    case 'swap': {
      const arr = [...next.inputArray]
      ;[arr[step.i], arr[step.j]] = [arr[step.j], arr[step.i]]
      next.inputArray = arr
      next.highlighted.array = [step.i, step.j]
      next.annotations.push(`Swap indices ${step.i} and ${step.j}.`)
      break
    }
    case 'annotation':
      next.annotations.push(step.text)
      break
    case 'code':
      next.codeBlock = step.text
      break
    case 'result':
      next.resultText = step.text
      break
    case 'arrow':
      next.annotations.push(step.label || `${step.from || 'start'} -> ${step.to || 'target'}`)
      break
    case 'graph':
      next.graph = {
        nodes: step.nodes.map((node) => ({ ...node })),
        edges: step.edges.map((edge) => ({ ...edge })),
      }
      break
    case 'visit_node':
      next.activeNode = step.node
      next.visitedNodes.add(step.node)
      next.annotations.push(`Visit node ${step.node}.`)
      break
    case 'frontier':
      next.frontier = { label: step.label, values: [...step.values] }
      break
    case 'matrix':
      next.matrix = step.values.map((row) => [...row])
      next.matrixLabel = step.label || 'dp'
      break
    case 'matrix_update':
      if (!next.matrix[step.row]) next.matrix[step.row] = []
      next.matrix[step.row][step.col] = step.value
      next.updatedMatrixCell = { row: step.row, col: step.col }
      break
    case 'highlight_cell':
      next.highlightedCell = { row: step.row, col: step.col }
      break
    default:
      break
  }

  return next
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Incrementally applies a single algorithm step onto the current board state.
 * Used by the frontend to sync one step per spoken sentence.
 * Returns the updated opaque board state (pass it back in on the next call).
 */
export function applyAlgorithmStep(
  instruction: AlgorithmInstruction,
  step: AlgorithmStep,
  boardState: BoardState | null,
  excalidrawAPI: any,
  options: { reset?: boolean } = {},
): BoardState {
  if (!excalidrawAPI) return boardState ?? createBoardState(normalizeInstruction(instruction))

  let state = boardState ?? createBoardState(normalizeInstruction(instruction))

  if (options.reset) {
    excalidrawAPI.updateScene({ elements: [], appState: { viewBackgroundColor: COLORS.canvas } })
    state = createBoardState(normalizeInstruction(instruction))
  }

  state = applyStep(state, step)
  const frame = renderAlgorithmFrame(state)
  excalidrawAPI.updateScene({ elements: frame.elements, appState: { viewBackgroundColor: COLORS.canvas } })
  excalidrawAPI.scrollToContent(frame.elements, {
    fitToContent: true,
    animate: true,
    duration: step.type === 'compare' || step.type === 'update' || step.type === 'swap' ? 220 : 420,
    minZoom: 0.42,
    maxZoom: 1.2,
  })

  return state
}

export async function animateAlgorithm(instruction: AlgorithmInstruction, excalidrawAPI: any, options: { reset?: boolean } = {}) {
  if (!instruction || !excalidrawAPI) return

  const normalized = normalizeInstruction(instruction)
  let state = createBoardState(normalized)

  if (options.reset !== false) {
    excalidrawAPI.updateScene({
      elements: [],
      appState: {
        viewBackgroundColor: COLORS.canvas,
      },
    })
  }

  for (const step of normalized.steps) {
    state = applyStep(state, step)
    const frame = renderAlgorithmFrame(state)
    excalidrawAPI.updateScene({
      elements: frame.elements,
      appState: {
        viewBackgroundColor: COLORS.canvas,
      },
    })
    excalidrawAPI.scrollToContent(frame.elements, {
      fitToContent: true,
      animate: true,
      duration: step.type === 'compare' || step.type === 'update' || step.type === 'swap' ? 220 : 420,
      minZoom: 0.42,
      maxZoom: 1.2,
    })
    await wait(step.type === 'compare' || step.type === 'update' || step.type === 'swap' ? FAST_DELAY_MS : STAGE_DELAY_MS)
  }
}


