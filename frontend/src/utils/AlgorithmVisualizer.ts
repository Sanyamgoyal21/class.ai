// ─────────────────────────────────────────────────────────────────────────────
//  AlgorithmVisualizer  –  Rich colorful step-by-step algorithm animations
// ─────────────────────────────────────────────────────────────────────────────

const C = {
  // Base
  ink:         '#0f172a',
  muted:       '#64748b',
  canvas:      '#f8fafc',
  white:       '#ffffff',
  slateSoft:   '#e2e8f0',

  // Accent palette (each algorithm gets its own "theme")
  blue:        '#2563eb',
  blueSoft:    '#dbeafe',
  blueGlow:    '#93c5fd',

  teal:        '#0d9488',
  tealSoft:    '#ccfbf1',

  violet:      '#7c3aed',
  violetSoft:  '#ede9fe',
  violetGlow:  '#c4b5fd',

  amber:       '#d97706',
  amberSoft:   '#fef3c7',
  amberGlow:   '#fcd34d',

  rose:        '#e11d48',
  roseSoft:    '#ffe4e6',
  roseGlow:    '#fda4af',

  emerald:     '#059669',
  emeraldSoft: '#d1fae5',
  emeraldGlow: '#6ee7b7',

  orange:      '#ea580c',
  orangeSoft:  '#ffedd5',

  pink:        '#db2777',
  pinkSoft:    '#fce7f3',

  sky:         '#0284c7',
  skySoft:     '#e0f2fe',

  lime:        '#65a30d',
  limeSoft:    '#ecfccb',

  // Semantic aliases kept for compatibility
  accent:      '#2563eb',
  accentSoft:  '#dbeafe',
  warm:        '#d97706',
  warmSoft:    '#fef3c7',
  success:     '#059669',
  successSoft: '#d1fae5',
  danger:      '#e11d48',
  dangerSoft:  '#ffe4e6',
}

// Per-algorithm theme: [primary stroke, primary fill, secondary stroke, compare stroke]
const ALGO_THEME: Record<string, [string, string, string, string]> = {
  binary_search_walkthrough: [C.blue,    C.blueSoft,    C.teal,    C.amber],
  bubble_sort:               [C.rose,    C.roseSoft,    C.emerald, C.amber],
  insertion_sort:            [C.violet,  C.violetSoft,  C.teal,    C.rose],
  selection_sort:            [C.orange,  C.orangeSoft,  C.blue,    C.rose],
  merge_sort:                [C.sky,     C.skySoft,     C.violet,  C.amber],
  quick_sort:                [C.pink,    C.pinkSoft,    C.blue,    C.amber],
  linear_search:             [C.teal,    C.tealSoft,    C.blue,    C.amber],
  lis_dp:                    [C.blue,    C.blueSoft,    C.emerald, C.violet],
  bfs:                       [C.emerald, C.emeraldSoft, C.teal,    C.amber],
  dfs:                       [C.violet,  C.violetSoft,  C.blue,    C.rose],
  knapsack_dp:               [C.amber,   C.amberSoft,   C.emerald, C.blue],
  stack_push_pop:            [C.rose,    C.roseSoft,    C.blue,    C.amber],
  queue_enqueue_dequeue:     [C.sky,     C.skySoft,     C.violet,  C.amber],
}

function themeOf(type: string) {
  return ALGO_THEME[type] ?? [C.blue, C.blueSoft, C.emerald, C.amber]
}

const FONT_FAMILY    = 1
const W              = 84   // cell width
const H              = 58   // cell height
const GAP            = 14   // gap between cells
const MATRIX_CELL    = 44
const STAGE_MS       = 750
const FAST_MS        = 380
const CODE_FONT      = 17

export type Primitive = string | number
type Point       = { x: number; y: number }
type SceneEl     = Record<string, any>

// ─── Step types ──────────────────────────────────────────────────────────────
type ArrayStep         = { type: 'array';          values: Primitive[]; label?: string }
type DpArrayStep       = { type: 'dp_array';       values: Primitive[]; label?: string }
type CompareStep       = { type: 'compare';        i: number; j: number }
type UpdateStep        = { type: 'update';         index: number; value: Primitive }
type HighlightStep     = { type: 'highlight_index'; index: number; row?: 'array' | 'dp' }
type ArrowStep         = { type: 'arrow';          from?: string; to?: string; label?: string }
type AnnotationStep    = { type: 'annotation';     text: string }
type CodeStep          = { type: 'code';           text: string }
type ResultStep        = { type: 'result';         text: string }
type SwapStep          = { type: 'swap';           i: number; j: number }
type GraphStep         = { type: 'graph'; nodes: Array<{ id: string; label?: string; x?: number; y?: number }>; edges: Array<{ from: string; to: string; label?: string }> }
type VisitNodeStep     = { type: 'visit_node';     node: string }
type FrontierStep      = { type: 'frontier';       label: string; values: string[] }
type MatrixStep        = { type: 'matrix';         values: Primitive[][]; label?: string }
type MatrixUpdateStep  = { type: 'matrix_update';  row: number; col: number; value: Primitive }
type HighlightCellStep = { type: 'highlight_cell'; row: number; col: number }
// New: colored pointer below a cell
type PointerStep       = { type: 'pointer'; index: number; label: string; color: string }
// New: mark a range of indices with a background color
type RangeStep         = { type: 'range'; from: number; to: number; color: string; fillColor: string; label?: string }
// New: pivot marker
type PivotStep         = { type: 'pivot'; index: number }

export type AlgorithmStep =
  | ArrayStep | DpArrayStep | CompareStep | UpdateStep | HighlightStep
  | ArrowStep | AnnotationStep | CodeStep | ResultStep | SwapStep
  | GraphStep | VisitNodeStep | FrontierStep
  | MatrixStep | MatrixUpdateStep | HighlightCellStep
  | PointerStep | RangeStep | PivotStep

// ─── Instruction types ───────────────────────────────────────────────────────
type BaseInstruction = { type: string; title?: string; code?: string; steps?: AlgorithmStep[] }

export type LisAlgorithmInstruction        = BaseInstruction & { type: 'lis_dp'; array?: Primitive[] }
export type BinarySearchInstruction        = BaseInstruction & { type: 'binary_search_walkthrough'; array?: Primitive[]; target?: Primitive }
export type BubbleSortInstruction          = BaseInstruction & { type: 'bubble_sort'; array?: Primitive[] }
export type InsertionSortInstruction       = BaseInstruction & { type: 'insertion_sort'; array?: Primitive[] }
export type SelectionSortInstruction       = BaseInstruction & { type: 'selection_sort'; array?: Primitive[] }
export type MergeSortInstruction           = BaseInstruction & { type: 'merge_sort'; array?: Primitive[] }
export type QuickSortInstruction           = BaseInstruction & { type: 'quick_sort'; array?: Primitive[] }
export type LinearSearchInstruction        = BaseInstruction & { type: 'linear_search'; array?: Primitive[]; target?: Primitive }
export type StackInstruction               = BaseInstruction & { type: 'stack_push_pop'; values?: Primitive[] }
export type QueueInstruction               = BaseInstruction & { type: 'queue_enqueue_dequeue'; values?: Primitive[] }

type GraphData = { nodes: Array<{ id: string; label?: string; x?: number; y?: number }>; edges: Array<{ from: string; to: string; label?: string }> }
export type GraphTraversalInstruction      = BaseInstruction & { type: 'bfs' | 'dfs'; graph?: GraphData; start?: string }
export type KnapsackInstruction            = BaseInstruction & { type: 'knapsack_dp'; weights?: number[]; values?: number[]; capacity?: number }

export type AlgorithmInstruction =
  | LisAlgorithmInstruction | BinarySearchInstruction
  | BubbleSortInstruction | InsertionSortInstruction
  | SelectionSortInstruction | MergeSortInstruction | QuickSortInstruction
  | LinearSearchInstruction | StackInstruction | QueueInstruction
  | GraphTraversalInstruction | KnapsackInstruction

// ─── Board state ─────────────────────────────────────────────────────────────
export type BoardState = {
  title:            string
  algoType:         string
  inputArray:       Primitive[]
  arrayLabel?:      string
  dpArray:          Primitive[]
  dpLabel?:         string
  highlighted:      { array: number[]; dp: number[] }
  activeComparison: { i: number; j: number } | null
  annotations:      string[]
  resultText:       string
  codeBlock:        string
  graph:            GraphData | null
  visitedNodes:     Set<string>
  activeNode:       string | null
  frontier:         { label: string; values: string[] } | null
  matrix:           Primitive[][]
  matrixLabel?:     string
  highlightedCell:  { row: number; col: number } | null
  updatedMatrixCell:{ row: number; col: number } | null
  headerNote:       string
  // New extended state
  pointers:         Array<{ index: number; label: string; color: string }>
  ranges:           Array<{ from: number; to: number; color: string; fillColor: string; label?: string }>
  pivotIndex:       number | null
}

// ─── Excalidraw element factories ────────────────────────────────────────────

function rng() { return Math.floor(Math.random() * 1_000_000) }

function base(type: string, x: number, y: number, w: number, h: number, o: Record<string, any> = {}): SceneEl {
  return {
    id: crypto.randomUUID(), type, x, y, width: w, height: h,
    strokeColor: C.ink, backgroundColor: 'transparent', fillStyle: 'solid',
    strokeWidth: 2, strokeStyle: 'solid', roughness: 0.3,
    opacity: 100, angle: 0, seed: rng(), version: 1, versionNonce: rng(),
    isDeleted: false, groupIds: [], frameId: null, boundElements: null,
    updated: Date.now(), link: null, locked: false, ...o,
  }
}

function txt(x: number, y: number, text: string, size = 24, color = C.ink, align: 'left' | 'center' | 'right' = 'left'): SceneEl {
  const w = Math.max(size, text.split('\n').reduce((m, l) => Math.max(m, l.length * size * 0.54), 0))
  const h = Math.max(size * 1.25, text.split('\n').length * size * 1.22)
  return base('text', x, y, w, h, {
    strokeColor: color, fontSize: size, fontFamily: FONT_FAMILY,
    text, originalText: text, textAlign: align, verticalAlign: 'middle',
    lineHeight: 1.25, containerId: null, autoResize: true,
  })
}

function rect(x: number, y: number, w: number, h: number, o: Record<string, any> = {}): SceneEl {
  return base('rectangle', x, y, w, h, o)
}

function ellipse(x: number, y: number, w: number, h: number, o: Record<string, any> = {}): SceneEl {
  return base('ellipse', x, y, w, h, o)
}

function arrow(x: number, y: number, pts: [number, number][], o: Record<string, any> = {}): SceneEl {
  const xs = pts.map(([px]) => px), ys = pts.map(([, py]) => py)
  return {
    ...base('arrow', x, y, Math.max(...xs) - Math.min(...xs) || 1, Math.max(...ys) - Math.min(...ys) || 1),
    points: pts, lastCommittedPoint: null,
    startBinding: null, endBinding: null,
    startArrowhead: null, endArrowhead: 'arrow', ...o,
  }
}


// ─── Layout helpers ───────────────────────────────────────────────────────────

function rowPositions(n: number, origin: Point, cellW = W, gap = GAP) {
  return Array.from({ length: n }, (_, i) => ({ x: origin.x + i * (cellW + gap), y: origin.y }))
}

function graphPositions(nodes: GraphData['nodes'], origin: Point = { x: 180, y: 500 }) {
  const fallback = [
    { x: origin.x,       y: origin.y },
    { x: origin.x + 170, y: origin.y - 100 },
    { x: origin.x + 170, y: origin.y + 100 },
    { x: origin.x + 340, y: origin.y - 150 },
    { x: origin.x + 340, y: origin.y + 150 },
    { x: origin.x + 510, y: origin.y },
  ]
  const map = new Map<string, Point>()
  nodes.forEach((n, i) => map.set(n.id, {
    x: n.x ?? fallback[i % fallback.length].x + Math.floor(i / fallback.length) * 120,
    y: n.y ?? fallback[i % fallback.length].y,
  }))
  return map
}

function adjMap(graph: GraphData) {
  const m = new Map<string, string[]>()
  graph.nodes.forEach(n => m.set(n.id, []))
  graph.edges.forEach(e => m.get(e.from)?.push(e.to))
  return m
}

function num(v: Primitive) { const n = Number(v); return Number.isFinite(n) ? n : 0 }

// ─── Render helpers ───────────────────────────────────────────────────────────

function renderArrayCells(
  values: Primitive[],
  origin: Point,
  label: string | undefined,
  highlighted: number[],
  algoType: string,
  updatedIndex: number | null = null,
  pointers: BoardState['pointers'] = [],
  ranges: BoardState['ranges'] = [],
  pivotIndex: number | null = null,
) {
  const [primary, primarySoft, secondary] = themeOf(algoType)
  const positions  = rowPositions(values.length, origin)
  const hlSet      = new Set(highlighted)
  const els: SceneEl[] = []

  if (label) els.push(txt(origin.x - 72, origin.y + 16, label, 22, C.muted))

  // Range backgrounds (drawn first, behind cells)
  ranges.forEach(r => {
    if (r.from < 0 || r.to >= values.length) return
    const p0 = positions[r.from], p1 = positions[r.to]
    const rx = p0.x - 6, ry = origin.y - 6
    const rw = p1.x + W - p0.x + 12, rh = H + 12
    els.push(rect(rx, ry, rw, rh, {
      strokeColor: r.color, backgroundColor: r.fillColor,
      strokeWidth: 2.5, strokeStyle: 'dashed', roughness: 0,
    }))
    if (r.label) els.push(txt(rx + 4, ry - 24, r.label, 18, r.color))
  })

  values.forEach((v, i) => {
    const p = positions[i]
    const isHL  = hlSet.has(i)
    const isUpd = updatedIndex === i
    const isPivot = pivotIndex === i

    let stroke = C.ink, fill = C.white, sw = 2
    if (isPivot)  { stroke = C.rose;    fill = C.roseSoft;    sw = 4 }
    else if (isUpd)  { stroke = secondary; fill = C.emeraldSoft; sw = 3.5 }
    else if (isHL)   { stroke = primary;   fill = primarySoft;   sw = 3.5 }

    els.push(rect(p.x, p.y, W, H, { strokeColor: stroke, backgroundColor: fill, strokeWidth: sw, roughness: 0.2 }))

    const textColor = isPivot ? C.rose : isHL || isUpd ? stroke : C.ink
    els.push(txt(p.x + W / 2 - 12, p.y + 12, String(v), 30, textColor, 'center'))
    els.push(txt(p.x + W / 2 - 6,  p.y + H + 8, String(i), 15, C.muted, 'center'))

    if (isPivot) {
      els.push(txt(p.x + W / 2 - 16, p.y - 26, 'pivot', 16, C.rose, 'center'))
    }
  })

  // Pointer arrows (below cells)
  pointers.forEach(ptr => {
    if (ptr.index < 0 || ptr.index >= positions.length) return
    const p = positions[ptr.index]
    const ax = p.x + W / 2
    const ay = origin.y + H + 36
    els.push(arrow(ax, ay + 18, [[0, 0], [0, -16]], {
      strokeColor: ptr.color, strokeWidth: 3,
      endArrowhead: 'arrow',
    }))
    els.push(txt(ax - 20, ay + 22, ptr.label, 18, ptr.color, 'center'))
  })

  return { els, positions }
}

function renderCompareArch(posA: Point, posB: Point, color: string): SceneEl[] {
  if (!posA || !posB) return []
  const x1 = posA.x + W / 2, x2 = posB.x + W / 2
  const y  = posA.y - 14
  const span = x2 - x1
  const els: SceneEl[] = []
  els.push(arrow(x1, y, [[0, 0], [span / 2, -44], [span, 0]], {
    strokeColor: color, strokeWidth: 3.5,
    strokeStyle: 'dashed',
  }))
  els.push(txt((x1 + x2) / 2 - 36, y - 62, 'compare?', 18, color))
  return els
}

function renderGraph(state: BoardState): SceneEl[] {
  if (!state.graph) return []
  const [primary, primarySoft] = themeOf(state.algoType)
  const positions = graphPositions(state.graph.nodes)
  const els: SceneEl[] = []

  state.graph.edges.forEach(e => {
    const f = positions.get(e.from), t = positions.get(e.to)
    if (!f || !t) return
    const visited = state.visitedNodes.has(e.from) && state.visitedNodes.has(e.to)
    els.push(arrow(f.x + 36, f.y + 36, [[0, 0], [t.x - f.x, t.y - f.y]], {
      strokeColor: visited ? C.emerald : C.slateSoft,
      strokeWidth: visited ? 3 : 2,
    }))
    if (e.label) els.push(txt((f.x + t.x) / 2 + 8, (f.y + t.y) / 2 - 10, e.label, 15, C.amber))
  })

  state.graph.nodes.forEach(n => {
    const p = positions.get(n.id)!
    const isVisited = state.visitedNodes.has(n.id)
    const isActive  = state.activeNode === n.id
    let stroke = primary, fill = primarySoft, sw = 2.5
    if (isActive)  { stroke = C.amber;   fill = C.amberSoft;   sw = 4 }
    if (isVisited) { stroke = C.emerald; fill = C.emeraldSoft; sw = 3 }
    els.push(ellipse(p.x, p.y, 72, 72, { strokeColor: stroke, backgroundColor: fill, strokeWidth: sw, roughness: 0.2 }))
    els.push(txt(p.x + 16, p.y + 18, n.label || n.id, 26, C.ink))
    if (isActive)  els.push(txt(p.x + 4, p.y - 28, '▶ active', 14, C.amber))
    if (isVisited && !isActive) els.push(txt(p.x + 8, p.y - 28, '✓ visited', 14, C.emerald))
  })

  return els
}

function renderMatrix(state: BoardState, origin: Point = { x: 110, y: 620 }): SceneEl[] {
  if (!state.matrix.length) return []
  const [primary, primarySoft] = themeOf(state.algoType)
  const els: SceneEl[] = [txt(origin.x - 60, origin.y + 8, state.matrixLabel || 'dp', 22, C.muted)]

  state.matrix.forEach((row, ri) => {
    row.forEach((v, ci) => {
      const x = origin.x + ci * (MATRIX_CELL + 8)
      const y = origin.y + ri * (MATRIX_CELL + 8)
      const isHL  = state.highlightedCell?.row === ri && state.highlightedCell?.col === ci
      const isUpd = state.updatedMatrixCell?.row === ri && state.updatedMatrixCell?.col === ci
      let stroke = C.slateSoft, fill = C.white, sw = 1.8
      if (isUpd) { stroke = C.emerald; fill = C.emeraldSoft; sw = 3 }
      else if (isHL) { stroke = primary;  fill = primarySoft;   sw = 2.8 }
      els.push(rect(x, y, MATRIX_CELL, MATRIX_CELL, { strokeColor: stroke, backgroundColor: fill, strokeWidth: sw, roughness: 0.1 }))
      els.push(txt(x + 10, y + 10, String(v), 17, isUpd ? C.emerald : C.ink))
    })
  })
  return els
}

// ─── Main frame renderer ─────────────────────────────────────────────────────

export function renderAlgorithmFrame(state: BoardState) {
  const els: SceneEl[] = []
  const [primary, , secondary, compareColor] = themeOf(state.algoType)

  // Title strip
  els.push(rect(80, 42, 800, 56, { strokeColor: 'transparent', backgroundColor: primary, strokeWidth: 0, roughness: 0 }))
  els.push(txt(100, 52, state.title, 36, C.white))

  if (state.headerNote) {
    els.push(txt(100, 108, state.headerNote, 19, C.muted))
  }

  // Input array
  const arrayRow = state.inputArray.length
    ? renderArrayCells(
        state.inputArray,
        { x: 110, y: 190 },
        state.arrayLabel,
        state.highlighted.array,
        state.algoType,
        null,
        state.pointers,
        state.ranges,
        state.pivotIndex,
      )
    : null
  if (arrayRow) els.push(...arrayRow.els)

  // DP array (below)
  const dpRow = state.dpArray.length
    ? renderArrayCells(
        state.dpArray,
        { x: 110, y: 300 },
        state.dpLabel,
        state.highlighted.dp,
        state.algoType,
        state.highlighted.dp[0] ?? null,
      )
    : null
  if (dpRow) els.push(...dpRow.els)

  // Comparison arch
  if (state.activeComparison && arrayRow) {
    const pA = arrayRow.positions[state.activeComparison.j]
    const pB = arrayRow.positions[state.activeComparison.i]
    if (pA && pB) els.push(...renderCompareArch(pA, pB, compareColor))
  }

  // Annotations panel
  const annoY = state.dpArray.length ? 420 : 320
  state.annotations.slice(-7).forEach((note, i) => {
    const y = annoY + i * 38
    if (i === 0) {
      els.push(rect(104, y - 6, 520, 34, {
        strokeColor: secondary, backgroundColor: secondary + '22',
        strokeWidth: 1.5, roughness: 0,
      }))
    }
    els.push(txt(114, y, `• ${note}`, 21, i === 0 ? secondary : C.ink))
  })

  // Result box
  if (state.resultText) {
    const ry = state.dpArray.length ? annoY + 8 * 38 + 12 : annoY + 8 * 38
    els.push(rect(104, ry, 400, 58, { strokeColor: C.violet, backgroundColor: C.violetSoft, strokeWidth: 3.5, roughness: 0 }))
    els.push(txt(124, ry + 14, '🎯 ' + state.resultText, 24, C.violet))
  }

  // Frontier (BFS/DFS queue/stack)
  if (state.frontier) {
    const fy = state.dpArray.length ? 490 : 370
    els.push(rect(104, fy, 360, 50, { strokeColor: C.amber, backgroundColor: C.amberSoft, strokeWidth: 2, roughness: 0 }))
    els.push(txt(120, fy + 12, `${state.frontier.label}: [${state.frontier.values.join(', ')}]`, 20, C.amber))
  }

  // Code panel (right side)
  if (state.codeBlock) {
    const [, , , ] = themeOf(state.algoType)
    els.push(rect(960, 100, 460, 280, { strokeColor: C.slateSoft, backgroundColor: '#1e293b', strokeWidth: 1.5, roughness: 0 }))
    els.push(txt(978, 112, '// pseudocode', 16, '#94a3b8'))
    els.push(txt(978, 140, state.codeBlock, CODE_FONT, '#e2e8f0'))
  }

  // Graph
  els.push(...renderGraph(state))

  // Matrix
  els.push(...renderMatrix(state))

  return { elements: els, bounds: computeBounds(els) }
}

function computeBounds(elements: SceneEl[]) {
  if (!elements.length) return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const el of elements) {
    minX = Math.min(minX, el.x)
    minY = Math.min(minY, el.y)
    maxX = Math.max(maxX, el.x + (el.width || 0))
    maxY = Math.max(maxY, el.y + (el.height || 0))
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY }
}

// ─── Step generators ─────────────────────────────────────────────────────────

function createBinarySearchSteps(values: Primitive[], target: Primitive, code: string): AlgorithmStep[] {
  const steps: AlgorithmStep[] = [
    { type: 'array', values, label: 'sorted array' },
    { type: 'annotation', text: `Target = ${target}. Check the middle element each round.` },
    { type: 'code', text: code },
  ]
  let lo = 0, hi = values.length - 1
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2)
    steps.push({ type: 'pointer', index: lo,  label: 'lo',  color: C.teal })
    steps.push({ type: 'pointer', index: hi,  label: 'hi',  color: C.rose })
    steps.push({ type: 'pointer', index: mid, label: 'mid', color: C.amber })
    steps.push({ type: 'compare', i: mid, j: lo })
    steps.push({ type: 'annotation', text: `mid=${mid}, arr[mid]=${values[mid]}` })
    const mv = num(values[mid]), tv = num(target)
    if (mv === tv) {
      steps.push({ type: 'highlight_index', index: mid })
      steps.push({ type: 'result', text: `Found ${target} at index ${mid}! ✓` })
      return steps
    }
    if (mv < tv) {
      steps.push({ type: 'annotation', text: `${values[mid]} < ${target} → move lo right` })
      lo = mid + 1
    } else {
      steps.push({ type: 'annotation', text: `${values[mid]} > ${target} → move hi left` })
      hi = mid - 1
    }
  }
  steps.push({ type: 'result', text: `${target} not found in array.` })
  return steps
}

function createBubbleSortSteps(values: Primitive[], code: string): AlgorithmStep[] {
  const arr = [...values]
  const steps: AlgorithmStep[] = [
    { type: 'array', values: arr, label: 'array' },
    { type: 'annotation', text: 'Bubble sort: swap adjacent elements that are out of order.' },
    { type: 'code', text: code },
  ]
  for (let i = 0; i < arr.length - 1; i++) {
    for (let j = 0; j < arr.length - i - 1; j++) {
      steps.push({ type: 'compare', i: j, j: j + 1 })
      if (num(arr[j]) > num(arr[j + 1])) {
        ;[arr[j], arr[j + 1]] = [arr[j + 1], arr[j]]
        steps.push({ type: 'swap', i: j, j: j + 1 })
        steps.push({ type: 'annotation', text: `Swapped indices ${j} ↔ ${j + 1}` })
      }
    }
    // Mark sorted suffix
    steps.push({ type: 'range', from: arr.length - i - 1, to: arr.length - 1, color: C.emerald, fillColor: C.emeraldSoft + '88', label: 'sorted' })
    steps.push({ type: 'annotation', text: `Pass ${i + 1}: largest unsorted element settled.` })
  }
  steps.push({ type: 'result', text: `Sorted: [${arr.join(', ')}]` })
  return steps
}

function createInsertionSortSteps(values: Primitive[], code: string): AlgorithmStep[] {
  const arr = [...values]
  const steps: AlgorithmStep[] = [
    { type: 'array', values: arr, label: 'array' },
    { type: 'annotation', text: 'Insertion sort grows a sorted prefix one element at a time.' },
    { type: 'code', text: code },
  ]
  for (let i = 1; i < arr.length; i++) {
    steps.push({ type: 'highlight_index', index: i })
    steps.push({ type: 'pointer', index: i, label: 'insert', color: C.violet })
    steps.push({ type: 'range', from: 0, to: i - 1, color: C.teal, fillColor: C.tealSoft + '88', label: 'sorted' })
    let j = i
    while (j > 0) {
      steps.push({ type: 'compare', i: j - 1, j })
      if (num(arr[j - 1]) <= num(arr[j])) break
      ;[arr[j - 1], arr[j]] = [arr[j], arr[j - 1]]
      steps.push({ type: 'swap', i: j - 1, j })
      j--
    }
    steps.push({ type: 'annotation', text: `Element placed at index ${j}.` })
  }
  steps.push({ type: 'result', text: `Sorted: [${arr.join(', ')}]` })
  return steps
}

function createSelectionSortSteps(values: Primitive[], code: string): AlgorithmStep[] {
  const arr = [...values]
  const steps: AlgorithmStep[] = [
    { type: 'array', values: arr, label: 'array' },
    { type: 'annotation', text: 'Selection sort finds the minimum in unsorted part and swaps it to front.' },
    { type: 'code', text: code },
  ]
  for (let i = 0; i < arr.length - 1; i++) {
    let minIdx = i
    steps.push({ type: 'pointer', index: i, label: 'start', color: C.orange })
    for (let j = i + 1; j < arr.length; j++) {
      steps.push({ type: 'compare', i: minIdx, j })
      if (num(arr[j]) < num(arr[minIdx])) {
        minIdx = j
        steps.push({ type: 'pointer', index: minIdx, label: 'min', color: C.rose })
      }
    }
    if (minIdx !== i) {
      ;[arr[i], arr[minIdx]] = [arr[minIdx], arr[i]]
      steps.push({ type: 'swap', i, j: minIdx })
      steps.push({ type: 'annotation', text: `Swapped min (index ${minIdx}) → position ${i}` })
    }
    steps.push({ type: 'range', from: 0, to: i, color: C.emerald, fillColor: C.emeraldSoft + '88', label: 'sorted' })
  }
  steps.push({ type: 'result', text: `Sorted: [${arr.join(', ')}]` })
  return steps
}

function createMergeSortSteps(values: Primitive[], code: string): AlgorithmStep[] {
  const steps: AlgorithmStep[] = [
    { type: 'array', values, label: 'array' },
    { type: 'annotation', text: 'Merge Sort: divide array in half, sort each half, then merge.' },
    { type: 'code', text: code },
  ]
  const arr = [...values]

  function merge(a: Primitive[], lo: number, mid: number, hi: number) {
    const left = a.slice(lo, mid + 1), right = a.slice(mid + 1, hi + 1)
    steps.push({ type: 'range', from: lo,      to: mid, color: C.sky,    fillColor: C.skySoft + '88',    label: 'left' })
    steps.push({ type: 'range', from: mid + 1, to: hi,  color: C.violet, fillColor: C.violetSoft + '88', label: 'right' })
    steps.push({ type: 'annotation', text: `Merging [${lo}..${mid}] and [${mid + 1}..${hi}]` })
    let i = 0, j = 0, k = lo
    while (i < left.length && j < right.length) {
      steps.push({ type: 'compare', i: lo + i, j: mid + 1 + j })
      if (num(left[i]) <= num(right[j])) { a[k++] = left[i++] }
      else                               { a[k++] = right[j++] }
    }
    while (i < left.length) a[k++] = left[i++]
    while (j < right.length) a[k++] = right[j++]
    steps.push({ type: 'array', values: [...a], label: 'array' })
  }

  function mergeSort(a: Primitive[], lo: number, hi: number) {
    if (lo >= hi) return
    const mid = Math.floor((lo + hi) / 2)
    mergeSort(a, lo, mid)
    mergeSort(a, mid + 1, hi)
    merge(a, lo, mid, hi)
  }

  mergeSort(arr, 0, arr.length - 1)
  steps.push({ type: 'result', text: `Sorted: [${arr.join(', ')}]` })
  return steps
}

function createQuickSortSteps(values: Primitive[], code: string): AlgorithmStep[] {
  const arr = [...values]
  const steps: AlgorithmStep[] = [
    { type: 'array', values: arr, label: 'array' },
    { type: 'annotation', text: 'Quick Sort: pick a pivot, partition around it, recurse.' },
    { type: 'code', text: code },
  ]

  function partition(a: Primitive[], lo: number, hi: number): number {
    const pivot = a[hi]
    steps.push({ type: 'pivot', index: hi })
    steps.push({ type: 'annotation', text: `Pivot = ${pivot} at index ${hi}` })
    let i = lo - 1
    for (let j = lo; j < hi; j++) {
      steps.push({ type: 'compare', i: j, j: hi })
      if (num(a[j]) <= num(pivot)) {
        i++
        ;[a[i], a[j]] = [a[j], a[i]]
        if (i !== j) {
          steps.push({ type: 'swap', i, j })
        }
      }
    }
    ;[a[i + 1], a[hi]] = [a[hi], a[i + 1]]
    steps.push({ type: 'swap', i: i + 1, j: hi })
    steps.push({ type: 'annotation', text: `Pivot placed at index ${i + 1}` })
    steps.push({ type: 'array', values: [...a], label: 'array' })
    return i + 1
  }

  function qs(a: Primitive[], lo: number, hi: number) {
    if (lo >= hi) return
    const p = partition(a, lo, hi)
    qs(a, lo, p - 1)
    qs(a, p + 1, hi)
  }

  qs(arr, 0, arr.length - 1)
  steps.push({ type: 'result', text: `Sorted: [${arr.join(', ')}]` })
  return steps
}

function createLinearSearchSteps(values: Primitive[], target: Primitive, code: string): AlgorithmStep[] {
  const steps: AlgorithmStep[] = [
    { type: 'array', values, label: 'array' },
    { type: 'annotation', text: `Searching for ${target} by checking each element left-to-right.` },
    { type: 'code', text: code },
  ]
  for (let i = 0; i < values.length; i++) {
    steps.push({ type: 'highlight_index', index: i })
    steps.push({ type: 'pointer', index: i, label: 'check', color: C.teal })
    steps.push({ type: 'annotation', text: `Check index ${i}: ${values[i]} ${values[i] == target ? '= target ✓' : '≠ target'}` })
    if (values[i] == target) {
      steps.push({ type: 'result', text: `Found ${target} at index ${i}! ✓` })
      return steps
    }
  }
  steps.push({ type: 'result', text: `${target} not found.` })
  return steps
}

function createLisSteps(values: Primitive[], code: string): AlgorithmStep[] {
  const steps: AlgorithmStep[] = [
    { type: 'array', values, label: 'nums' },
    { type: 'dp_array', values: values.map(() => 1), label: 'dp' },
    { type: 'annotation', text: 'dp[i] = longest increasing subsequence ending at i' },
    { type: 'code', text: code },
  ]
  const dp = values.map(() => 1)
  let best = 1
  for (let i = 1; i < values.length; i++) {
    steps.push({ type: 'highlight_index', index: i, row: 'array' })
    steps.push({ type: 'pointer', index: i, label: 'i', color: C.blue })
    for (let j = 0; j < i; j++) {
      steps.push({ type: 'compare', i, j })
      if (num(values[j]) < num(values[i]) && dp[j] + 1 > dp[i]) {
        dp[i] = dp[j] + 1
        best = Math.max(best, dp[i])
        steps.push({ type: 'update', index: i, value: dp[i] })
        steps.push({ type: 'annotation', text: `dp[${i}] updated to ${dp[i]}` })
      }
    }
  }
  steps.push({ type: 'result', text: `LIS length = ${best}` })
  return steps
}

function createTraversalSteps(type: 'bfs' | 'dfs', graph: GraphData, start: string, code: string): AlgorithmStep[] {
  const adj = adjMap(graph)
  const steps: AlgorithmStep[] = [
    { type: 'graph', nodes: graph.nodes, edges: graph.edges },
    { type: 'annotation', text: `${type.toUpperCase()} explores nodes in a systematic order.` },
    { type: 'code', text: code },
  ]
  const order: string[] = []
  if (type === 'bfs') {
    const queue = [start], seen = new Set([start])
    while (queue.length) {
      steps.push({ type: 'frontier', label: 'queue', values: [...queue] })
      const node = queue.shift()!
      order.push(node)
      steps.push({ type: 'visit_node', node })
      for (const next of adj.get(node) || []) {
        if (!seen.has(next)) { seen.add(next); queue.push(next) }
      }
    }
  } else {
    const stack = [start], seen = new Set<string>()
    while (stack.length) {
      steps.push({ type: 'frontier', label: 'stack', values: [...stack] })
      const node = stack.pop()!
      if (seen.has(node)) continue
      seen.add(node)
      order.push(node)
      steps.push({ type: 'visit_node', node })
      const nbrs = [...(adj.get(node) || [])].reverse()
      nbrs.forEach(next => { if (!seen.has(next)) stack.push(next) })
    }
  }
  steps.push({ type: 'result', text: `${type.toUpperCase()} order: ${order.join(' → ')}` })
  return steps
}

function createKnapsackSteps(weights: number[], values: number[], capacity: number, code: string): AlgorithmStep[] {
  const rows = weights.length + 1, cols = capacity + 1
  const matrix: number[][] = Array.from({ length: rows }, () => Array(cols).fill(0))
  const steps: AlgorithmStep[] = [
    { type: 'annotation', text: 'dp[i][w] = best value using first i items with capacity w.' },
    { type: 'code', text: code },
    { type: 'matrix', values: matrix.map(r => [...r]), label: 'dp' },
  ]
  for (let i = 1; i <= weights.length; i++) {
    for (let cap = 0; cap <= capacity; cap++) {
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

function createStackSteps(values: Primitive[], code: string): AlgorithmStep[] {
  const steps: AlgorithmStep[] = [
    { type: 'array', values: [], label: 'stack' },
    { type: 'annotation', text: 'Stack: LIFO — Last In, First Out. Push adds to top, Pop removes from top.' },
    { type: 'code', text: code },
  ]
  const stack: Primitive[] = []
  values.forEach((v, i) => {
    stack.push(v)
    steps.push({ type: 'array', values: [...stack], label: 'stack' })
    steps.push({ type: 'highlight_index', index: stack.length - 1 })
    steps.push({ type: 'pointer', index: stack.length - 1, label: 'top', color: C.rose })
    steps.push({ type: 'annotation', text: `PUSH ${v} → stack: [${stack.join(', ')}]` })
    if (i % 2 === 1 && stack.length > 0) {
      const popped = stack.pop()
      steps.push({ type: 'array', values: [...stack], label: 'stack' })
      steps.push({ type: 'annotation', text: `POP → removed ${popped}, stack: [${stack.join(', ')}]` })
    }
  })
  steps.push({ type: 'result', text: `Final stack: [${stack.join(', ')}]` })
  return steps
}

function createQueueSteps(values: Primitive[], code: string): AlgorithmStep[] {
  const steps: AlgorithmStep[] = [
    { type: 'array', values: [], label: 'queue' },
    { type: 'annotation', text: 'Queue: FIFO — First In, First Out. Enqueue adds to back, Dequeue removes from front.' },
    { type: 'code', text: code },
  ]
  const queue: Primitive[] = []
  values.forEach((v, i) => {
    queue.push(v)
    steps.push({ type: 'array', values: [...queue], label: 'queue' })
    steps.push({ type: 'pointer', index: 0, label: 'front', color: C.sky })
    steps.push({ type: 'pointer', index: queue.length - 1, label: 'back', color: C.violet })
    steps.push({ type: 'annotation', text: `ENQUEUE ${v} → queue: [${queue.join(', ')}]` })
    if (i % 2 === 1 && queue.length > 0) {
      const dequeued = queue.shift()
      steps.push({ type: 'array', values: [...queue], label: 'queue' })
      steps.push({ type: 'annotation', text: `DEQUEUE → removed ${dequeued}, queue: [${queue.join(', ')}]` })
    }
  })
  steps.push({ type: 'result', text: `Final queue: [${queue.join(', ')}]` })
  return steps
}

// ─── Normalize instruction → attach generated steps ──────────────────────────

function label(type: string) {
  return type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

export function normalizeInstruction(instruction: AlgorithmInstruction): Required<AlgorithmInstruction> {
  const title = instruction.title || label(instruction.type)
  const code  = instruction.code || ''

  if ((instruction as any).steps?.length) {
    return { ...instruction, title, code } as any
  }

  switch (instruction.type) {
    case 'binary_search_walkthrough': {
      const array  = (instruction as BinarySearchInstruction).array?.length ? (instruction as BinarySearchInstruction).array! : [1,3,5,7,9,11,13,15,17,19]
      const target = (instruction as BinarySearchInstruction).target ?? 11
      return { ...instruction, title, code, array, target, steps: createBinarySearchSteps(array, target, code) } as any
    }
    case 'bubble_sort': {
      const array = (instruction as BubbleSortInstruction).array?.length ? (instruction as BubbleSortInstruction).array! : [64,34,25,12,22,11,90]
      return { ...instruction, title, code, array, steps: createBubbleSortSteps(array, code) } as any
    }
    case 'insertion_sort': {
      const array = (instruction as InsertionSortInstruction).array?.length ? (instruction as InsertionSortInstruction).array! : [12,11,13,5,6,7]
      return { ...instruction, title, code, array, steps: createInsertionSortSteps(array, code) } as any
    }
    case 'selection_sort': {
      const array = (instruction as SelectionSortInstruction).array?.length ? (instruction as SelectionSortInstruction).array! : [29,10,14,37,13]
      return { ...instruction, title, code, array, steps: createSelectionSortSteps(array, code) } as any
    }
    case 'merge_sort': {
      const array = (instruction as MergeSortInstruction).array?.length ? (instruction as MergeSortInstruction).array! : [38,27,43,3,9,82,10]
      return { ...instruction, title, code, array, steps: createMergeSortSteps(array, code) } as any
    }
    case 'quick_sort': {
      const array = (instruction as QuickSortInstruction).array?.length ? (instruction as QuickSortInstruction).array! : [10,7,8,9,1,5]
      return { ...instruction, title, code, array, steps: createQuickSortSteps(array, code) } as any
    }
    case 'linear_search': {
      const array  = (instruction as LinearSearchInstruction).array?.length ? (instruction as LinearSearchInstruction).array! : [4,2,7,1,9,3,6,8]
      const target = (instruction as LinearSearchInstruction).target ?? 9
      return { ...instruction, title, code, array, target, steps: createLinearSearchSteps(array, target, code) } as any
    }
    case 'stack_push_pop': {
      const values = (instruction as StackInstruction).values?.length ? (instruction as StackInstruction).values! : [10,20,30,40,50]
      return { ...instruction, title, code, values, steps: createStackSteps(values, code) } as any
    }
    case 'queue_enqueue_dequeue': {
      const values = (instruction as QueueInstruction).values?.length ? (instruction as QueueInstruction).values! : [10,20,30,40,50]
      return { ...instruction, title, code, values, steps: createQueueSteps(values, code) } as any
    }
    case 'lis_dp': {
      const array = (instruction as LisAlgorithmInstruction).array?.length ? (instruction as LisAlgorithmInstruction).array! : [10,9,2,5,3,7,101,18]
      return { ...instruction, title, code, array, steps: createLisSteps(array, code) } as any
    }
    case 'bfs':
    case 'dfs': {
      const i    = instruction as GraphTraversalInstruction
      const graph = i.graph?.nodes?.length ? i.graph : {
        nodes: [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }, { id: 'E' }, { id: 'F' }],
        edges: [{ from: 'A', to: 'B' }, { from: 'A', to: 'C' }, { from: 'B', to: 'D' }, { from: 'B', to: 'E' }, { from: 'C', to: 'F' }],
      }
      const start = i.start || graph.nodes[0]?.id || 'A'
      return { ...instruction, title, code, graph, start, steps: createTraversalSteps(instruction.type, graph, start, code) } as any
    }
    case 'knapsack_dp': {
      const i = instruction as KnapsackInstruction
      const weights  = i.weights?.length ? i.weights : [1, 3, 4, 5]
      const values   = i.values?.length  ? i.values  : [1, 4, 5, 7]
      const capacity = typeof i.capacity === 'number' ? i.capacity : 7
      return { ...instruction, title, code, weights, values, capacity, steps: createKnapsackSteps(weights, values, capacity, code) } as any
    }
    default:
      return { ...instruction, title, code, steps: [] } as any
  }
}

// ─── State machine ────────────────────────────────────────────────────────────

function mkBoardState(instruction: AlgorithmInstruction): BoardState {
  return {
    title:            instruction.title || label(instruction.type),
    algoType:         instruction.type,
    inputArray:       [],
    arrayLabel:       'input',
    dpArray:          [],
    dpLabel:          'dp',
    highlighted:      { array: [], dp: [] },
    activeComparison: null,
    annotations:      [],
    resultText:       '',
    codeBlock:        (instruction as any).code || '',
    graph:            null,
    visitedNodes:     new Set(),
    activeNode:       null,
    frontier:         null,
    matrix:           [],
    matrixLabel:      'dp',
    highlightedCell:  null,
    updatedMatrixCell:null,
    headerNote:       '',
    pointers:         [],
    ranges:           [],
    pivotIndex:       null,
  }
}

function cloneState(s: BoardState): BoardState {
  return {
    ...s,
    inputArray:   [...s.inputArray],
    dpArray:      [...s.dpArray],
    highlighted:  { array: [...s.highlighted.array], dp: [...s.highlighted.dp] },
    annotations:  [...s.annotations],
    visitedNodes: new Set(s.visitedNodes),
    frontier:     s.frontier ? { label: s.frontier.label, values: [...s.frontier.values] } : null,
    graph:        s.graph ? { nodes: s.graph.nodes.map(n => ({ ...n })), edges: s.graph.edges.map(e => ({ ...e })) } : null,
    matrix:       s.matrix.map(r => [...r]),
    pointers:     [...s.pointers],
    ranges:       [...s.ranges],
  }
}

function applyStep(state: BoardState, step: AlgorithmStep): BoardState {
  const next = cloneState(state)
  next.activeComparison  = null
  next.highlighted       = { array: [], dp: [] }
  next.highlightedCell   = null
  next.updatedMatrixCell = null
  next.pointers          = []
  next.ranges            = []
  next.pivotIndex        = null

  switch (step.type) {
    case 'array':
      next.inputArray = [...step.values]
      next.arrayLabel = step.label ?? next.arrayLabel
      next.headerNote = 'Step-by-step walkthrough'
      break
    case 'dp_array':
      next.dpArray = [...step.values]
      next.dpLabel  = step.label ?? 'dp'
      break
    case 'compare':
      next.activeComparison    = { i: step.i, j: step.j }
      next.highlighted.array   = [step.i, step.j]
      break
    case 'update':
      next.dpArray[step.index] = step.value
      next.highlighted.dp      = [step.index]
      break
    case 'highlight_index':
      next.highlighted[step.row === 'dp' ? 'dp' : 'array'] = [step.index]
      break
    case 'swap': {
      const arr = [...next.inputArray]
      ;[arr[step.i], arr[step.j]] = [arr[step.j], arr[step.i]]
      next.inputArray          = arr
      next.highlighted.array   = [step.i, step.j]
      next.annotations.push(`Swap ${step.i} ↔ ${step.j}`)
      break
    }
    case 'annotation': next.annotations.push(step.text);  break
    case 'code':       next.codeBlock = step.text;         break
    case 'result':     next.resultText = step.text;        break
    case 'arrow':      next.annotations.push(step.label || `${step.from} → ${step.to}`); break
    case 'graph':
      next.graph = { nodes: step.nodes.map(n => ({ ...n })), edges: step.edges.map(e => ({ ...e })) }
      break
    case 'visit_node':
      next.activeNode = step.node
      next.visitedNodes.add(step.node)
      next.annotations.push(`Visit ${step.node}`)
      break
    case 'frontier':       next.frontier          = { label: step.label, values: [...step.values] }; break
    case 'matrix':         next.matrix            = step.values.map(r => [...r]); next.matrixLabel = step.label ?? 'dp'; break
    case 'matrix_update':  if (!next.matrix[step.row]) next.matrix[step.row] = []; next.matrix[step.row][step.col] = step.value; next.updatedMatrixCell = { row: step.row, col: step.col }; break
    case 'highlight_cell': next.highlightedCell   = { row: step.row, col: step.col }; break
    case 'pointer':        next.pointers.push({ index: step.index, label: step.label, color: step.color }); break
    case 'range':          next.ranges.push({ from: step.from, to: step.to, color: step.color, fillColor: step.fillColor, label: step.label }); break
    case 'pivot':          next.pivotIndex = step.index; next.highlighted.array = [step.index]; break
    default:               break
  }
  return next
}

function wait(ms: number) { return new Promise(r => setTimeout(r, ms)) }

function stepDelay(step: AlgorithmStep): number {
  switch (step.type) {
    case 'compare':
    case 'swap':
    case 'update':
    case 'matrix_update':
    case 'pointer':
    case 'pivot':
      return FAST_MS
    default:
      return STAGE_MS
  }
}

function animDuration(step: AlgorithmStep): number {
  switch (step.type) {
    case 'compare':
    case 'swap':
    case 'pointer':
    case 'pivot':
      return 180
    default:
      return 380
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function applyAlgorithmStep(
  instruction: AlgorithmInstruction,
  step: AlgorithmStep,
  boardState: BoardState | null,
  excalidrawAPI: any,
  options: { reset?: boolean } = {},
): BoardState {
  if (!excalidrawAPI) return boardState ?? mkBoardState(normalizeInstruction(instruction) as any)

  let state = boardState ?? mkBoardState(normalizeInstruction(instruction) as any)

  if (options.reset) {
    excalidrawAPI.updateScene({ elements: [], appState: { viewBackgroundColor: C.canvas } })
    state = mkBoardState(normalizeInstruction(instruction) as any)
  }

  state = applyStep(state, step)
  const frame = renderAlgorithmFrame(state)
  excalidrawAPI.updateScene({ elements: frame.elements, appState: { viewBackgroundColor: C.canvas } })
  excalidrawAPI.scrollToContent(frame.elements, {
    fitToContent: true, animate: true, duration: animDuration(step), minZoom: 0.38, maxZoom: 1.25,
  })
  return state
}

export async function animateAlgorithm(
  instruction: AlgorithmInstruction,
  excalidrawAPI: any,
  options: { reset?: boolean } = {},
) {
  if (!instruction || !excalidrawAPI) return

  const normalized = normalizeInstruction(instruction)
  let state = mkBoardState(normalized as any)

  if (options.reset !== false) {
    excalidrawAPI.updateScene({ elements: [], appState: { viewBackgroundColor: C.canvas } })
  }

  for (const step of (normalized as any).steps as AlgorithmStep[]) {
    state = applyStep(state, step)
    const frame = renderAlgorithmFrame(state)
    excalidrawAPI.updateScene({ elements: frame.elements, appState: { viewBackgroundColor: C.canvas } })
    excalidrawAPI.scrollToContent(frame.elements, {
      fitToContent: true, animate: true, duration: animDuration(step), minZoom: 0.38, maxZoom: 1.25,
    })
    await wait(stepDelay(step))
  }
}
