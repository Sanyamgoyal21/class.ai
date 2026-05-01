const COLORS = {
  ink: '#0f172a',
  accent: '#2563eb',
  muted: '#64748b',
  warm: '#f59e0b',
  success: '#059669',
  canvas: '#ffffff',
}

const FONT_FAMILY = 1

type SceneElement = Record<string, any>

export type VisualInstruction = {
  id: string
  type: 'shape' | 'text' | 'line' | 'arrow'
  content: string
  position: { x: number; y: number }
  style?: { color?: string; highlight?: boolean; shape?: 'rectangle' | 'ellipse' | 'diamond' | 'triangle' }
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

function textElement(x: number, y: number, text: string, fontSize = 24, color = COLORS.ink) {
  const width = Math.max(fontSize, text.length * fontSize * 0.56)
  const height = fontSize * 1.3
  return baseElement('text', x, y, width, height, {
    strokeColor: color,
    fontSize,
    fontFamily: FONT_FAMILY,
    text,
    originalText: text,
    textAlign: 'center',
    verticalAlign: 'middle',
    lineHeight: 1.25,
    containerId: null,
    autoResize: true,
  })
}

function rectangleElement(x: number, y: number, width: number, height: number, color: string, highlight: boolean) {
  return baseElement('rectangle', x, y, width, height, {
    strokeColor: color,
    backgroundColor: highlight ? `${color}22` : '#ffffff',
    strokeWidth: highlight ? 3 : 2,
  })
}

function lineElement(x: number, y: number, color: string, arrow = false) {
  const points: [number, number][] = [[0, 0], [120, 0]]
  return {
    ...baseElement(arrow ? 'arrow' : 'line', x, y, 120, 1, {
      strokeColor: color,
      endArrowhead: arrow ? 'arrow' : null,
    }),
    points,
    lastCommittedPoint: null,
    startBinding: null,
    endBinding: null,
    startArrowhead: null,
  }
}

function visualToElements(visual: VisualInstruction): SceneElement[] {
  const color = visual.style?.color || COLORS.accent
  const highlight = Boolean(visual.style?.highlight)
  const x = Number.isFinite(visual.position?.x) ? visual.position.x : 240
  const y = Number.isFinite(visual.position?.y) ? visual.position.y : 180
  const content = String(visual.content || '')

  const shapeType = (visual.style?.shape || 'rectangle') as string

  switch (visual.type) {
    case 'text':
      return [textElement(x, y, content, highlight ? 28 : 24, color)]
    case 'line':
      return [
        lineElement(x, y, color, false),
        ...(content ? [textElement(x + 60, y - 28, content, 18, COLORS.muted)] : []),
      ]
    case 'arrow':
      return [
        lineElement(x, y, color, true),
        ...(content ? [textElement(x + 60, y - 28, content, 18, COLORS.muted)] : []),
      ]
    case 'shape': {
      const shape = baseElement(shapeType, x, y, 120, 68, {
        strokeColor: color,
        backgroundColor: highlight ? `${color}22` : '#ffffff',
        strokeWidth: highlight ? 3 : 2,
      })
      return [
        shape,
        ...(content ? [textElement(x + 60, y + 22, content, 20, COLORS.ink)] : []),
      ]
    }
    default:
      return [
        rectangleElement(x, y, 120, 68, color, highlight),
        ...(content ? [textElement(x + 60, y + 22, content, 20, COLORS.ink)] : []),
      ]
  }
}

export function renderVisualsChunk(visuals: VisualInstruction[], excalidrawAPI: any, options: { reset?: boolean } = {}) {
  if (!excalidrawAPI || !Array.isArray(visuals)) return

  const nextElements = visuals.flatMap((visual) => visualToElements(visual))
  const currentElements = options.reset ? [] : (excalidrawAPI.getSceneElements?.() || [])

  excalidrawAPI.updateScene({
    elements: [...currentElements, ...nextElements],
    appState: { viewBackgroundColor: COLORS.canvas },
  })
}
