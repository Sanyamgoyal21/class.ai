import type { LessonPlan, TemplateEntity, TimelineOp } from './teachingTemplates'

const CANVAS_BG = '#ffffff'
const HIGHLIGHT_COLOR = '#fbbf24'
const FONT_FAMILY = 1
const MIN_GAP = 28
const SCENE_MARGIN = 140

type SceneElement = Record<string, any>
type Bounds = { x: number; y: number; width: number; height: number }
type Point = { x: number; y: number }

type BoardState = {
  plan: LessonPlan | null
  sceneElements: SceneElement[]
  entityElementIds: Map<string, string[]>
  renderedEntityIds: Set<string>
  activeHighlights: Set<string>
  connections: Set<string>
  frameHandle: number | null
  layoutBounds: Map<string, Bounds>
}

function randomSeed() {
  return Math.floor(Math.random() * 1_000_000)
}

function elementId(prefix: string, entityId: string) {
  return `${prefix}:${entityId}`
}

function baseElement(
  id: string,
  type: string,
  x: number,
  y: number,
  width: number,
  height: number,
  overrides: Record<string, any> = {},
) {
  return {
    id,
    type,
    x,
    y,
    width,
    height,
    strokeColor: '#0f172a',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 0.35,
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

function textMetrics(text: string, fontSize: number) {
  const lines = String(text || '').split('\n')
  const width = Math.max(
    fontSize * 1.15,
    ...lines.map((line) => Math.max(fontSize * 0.58, line.length * fontSize * 0.56)),
  )
  const height = Math.max(fontSize * 1.3, lines.length * fontSize * 1.22)
  return { width, height }
}

function textElement(
  id: string,
  x: number,
  y: number,
  text: string,
  fontSize = 24,
  color = '#0f172a',
  textAlign: 'left' | 'center' | 'right' = 'center',
) {
  const { width, height } = textMetrics(text, fontSize)
  return baseElement(id, 'text', x, y, width, height, {
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

function linearElement(
  id: string,
  type: 'line' | 'arrow',
  x: number,
  y: number,
  points: [number, number][],
  overrides: Record<string, any> = {},
) {
  const xs = points.map(([px]) => px)
  const ys = points.map(([, py]) => py)
  return {
    ...baseElement(
      id,
      type,
      x,
      y,
      Math.max(...xs) - Math.min(...xs) || 1,
      Math.max(...ys) - Math.min(...ys) || 1,
      overrides,
    ),
    points,
    lastCommittedPoint: null,
    startBinding: overrides.startBinding || null,
    endBinding: overrides.endBinding || null,
    startArrowhead: overrides.startArrowhead ?? null,
    endArrowhead: overrides.endArrowhead ?? null,
  }
}

function scaleBetween(start: number, end: number, progress: number) {
  return start + (end - start) * progress
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value))
}

function rawEntityBounds(entity: TemplateEntity): Bounds {
  if (entity.kind === 'rectangle' || entity.kind === 'ellipse' || entity.kind === 'diamond' || entity.kind === 'triangle') {
    return { x: entity.x, y: entity.y, width: entity.width, height: entity.height }
  }

  if (entity.kind === 'text') {
    const fontSize = entity.style?.fontSize || 28
    const metrics = textMetrics(entity.text, fontSize)
    return { x: entity.x - metrics.width / 2, y: entity.y - metrics.height / 2, width: metrics.width, height: metrics.height }
  }

  if (entity.kind === 'line') {
    return {
      x: Math.min(entity.x1, entity.x2),
      y: Math.min(entity.y1, entity.y2),
      width: Math.abs(entity.x2 - entity.x1) || 2,
      height: Math.abs(entity.y2 - entity.y1) || 2,
    }
  }

  return { x: 0, y: 0, width: 0, height: 0 }
}

function centerOf(bounds: Bounds): Point {
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
}

function overlaps(a: Bounds, b: Bounds, gap = MIN_GAP) {
  return !(
    a.x + a.width + gap <= b.x ||
    b.x + b.width + gap <= a.x ||
    a.y + a.height + gap <= b.y ||
    b.y + b.height + gap <= a.y
  )
}

function resolveLayout(plan: LessonPlan): Map<string, Bounds> {
  const entries = Object.values(plan.board_template.entities)
    .filter((entity) => entity.kind !== 'connector')
    .sort((a, b) => {
      const ab = rawEntityBounds(a)
      const bb = rawEntityBounds(b)
      return ab.y - bb.y || ab.x - bb.x
    })

  const layout = new Map<string, Bounds>()

  for (const entity of entries) {
    const bounds = { ...rawEntityBounds(entity) }

    for (const existing of layout.values()) {
      if (!overlaps(bounds, existing)) continue

      const sameRow = Math.abs(bounds.y - existing.y) < Math.max(bounds.height, existing.height) * 0.65
      if (sameRow) {
        bounds.x = Math.max(bounds.x, existing.x + existing.width + MIN_GAP)
      } else {
        bounds.y = Math.max(bounds.y, existing.y + existing.height + MIN_GAP)
      }
    }

    layout.set(entity.id, bounds)
  }

  const placed = Array.from(layout.values())
  if (!placed.length) return layout

  const minX = Math.min(...placed.map((item) => item.x))
  const minY = Math.min(...placed.map((item) => item.y))
  const maxX = Math.max(...placed.map((item) => item.x + item.width))
  const sceneWidth = maxX - minX
  const offsetX = Math.max(0, SCENE_MARGIN - minX) + Math.max(0, (220 - sceneWidth) / 2)
  const offsetY = Math.max(0, SCENE_MARGIN - minY)

  for (const [id, bounds] of layout.entries()) {
    layout.set(id, {
      x: bounds.x + offsetX,
      y: bounds.y + offsetY,
      width: bounds.width,
      height: bounds.height,
    })
  }

  return layout
}

function boundTextFontSize(bounds: Bounds, text: string, preferred = 20) {
  if (!text) return preferred

  const longestLine = Math.max(...text.split('\n').map((line) => line.length || 1))
  const widthBased = bounds.width / Math.max(4.4, longestLine * 0.56)
  const heightBased = bounds.height / 3.1
  return Math.max(14, Math.min(preferred, Math.floor(Math.min(widthBased, heightBased))))
}

function getEdgeDockPoint(from: Bounds, to: Bounds): Point {
  const fromCenter = centerOf(from)
  const toCenter = centerOf(to)
  const dx = toCenter.x - fromCenter.x
  const dy = toCenter.y - fromCenter.y

  if (Math.abs(dx) > Math.abs(dy)) {
    return {
      x: fromCenter.x + (dx >= 0 ? from.width / 2 : -from.width / 2),
      y: fromCenter.y,
    }
  }

  return {
    x: fromCenter.x,
    y: fromCenter.y + (dy >= 0 ? from.height / 2 : -from.height / 2),
  }
}

function normalizePoints(points: [number, number][]) {
  const xs = points.map(([x]) => x)
  const ys = points.map(([, y]) => y)
  const originX = Math.min(...xs)
  const originY = Math.min(...ys)

  return {
    x: originX,
    y: originY,
    points: points.map(([px, py]) => [px - originX, py - originY] as [number, number]),
  }
}

export function createBoardExecutor(excalidrawAPI: any) {
  const state: BoardState = {
    plan: null,
    sceneElements: [],
    entityElementIds: new Map(),
    renderedEntityIds: new Set(),
    activeHighlights: new Set(),
    connections: new Set(),
    frameHandle: null,
    layoutBounds: new Map(),
  }

  const getRenderedElementId = (entityId: string) => {
    const ids = state.entityElementIds.get(entityId)
    return ids && ids.length ? ids[0] : null
  }

  const getLayoutBounds = (entityId: string) => {
    if (state.layoutBounds.has(entityId)) return state.layoutBounds.get(entityId) || null
    const entity = state.plan?.board_template.entities?.[entityId]
    return entity ? rawEntityBounds(entity) : null
  }

  const syncScene = (animateViewport = false) => {
    if (!excalidrawAPI) return
    excalidrawAPI.updateScene({
      elements: state.sceneElements,
      appState: { viewBackgroundColor: CANVAS_BG },
    })
    if (animateViewport && state.sceneElements.length) {
      excalidrawAPI.scrollToContent(state.sceneElements, {
        fitToContent: true,
        animate: true,
        duration: 260,
        minZoom: 0.35,
        maxZoom: 1.25,
      })
    }
  }

  const upsertElements = (elements: SceneElement[]) => {
    const map = new Map(state.sceneElements.map((element) => [element.id, element]))
    for (const element of elements) map.set(element.id, element)
    state.sceneElements = Array.from(map.values())
  }

  const removeElements = (ids: string[]) => {
    const removeSet = new Set(ids)
    state.sceneElements = state.sceneElements.filter((element) => !removeSet.has(element.id))
  }

  const entityBounds = (entityId: string) => {
    const entity = state.plan?.board_template.entities?.[entityId]
    if (!entity) return null

    if (entity.kind === 'connector') {
      const fromBounds = getLayoutBounds(entity.from)
      const toBounds = getLayoutBounds(entity.to)
      if (!fromBounds || !toBounds) return null

      const from = getEdgeDockPoint(fromBounds, toBounds)
      const to = getEdgeDockPoint(toBounds, fromBounds)
      return {
        x: Math.min(from.x, to.x),
        y: Math.min(from.y, to.y),
        width: Math.abs(to.x - from.x) || 2,
        height: Math.abs(to.y - from.y) || 2,
      }
    }

    return getLayoutBounds(entityId)
  }

  const attachConnectorToShapes = (connectorId: string, fromId: string, toId: string) => {
    const fromShapeId = getRenderedElementId(fromId)
    const toShapeId = getRenderedElementId(toId)
    if (!fromShapeId || !toShapeId) return

    state.sceneElements = state.sceneElements.map((element) => {
      if (element.id !== fromShapeId && element.id !== toShapeId) return element
      const existing = Array.isArray(element.boundElements) ? element.boundElements : []
      if (existing.some((item: any) => item?.id === connectorId)) return element
      return {
        ...element,
        boundElements: [...existing, { id: connectorId, type: 'arrow' }],
      }
    })
  }

  const buildEntityElements = (entity: TemplateEntity, progress = 1) => {
    const safeProgress = clamp01(progress)
    const strokeColor = entity.style && typeof (entity.style as any).strokeColor === 'string' ? (entity.style as any).strokeColor : '#2563eb'
    const fillColor = entity.style && typeof (entity.style as any).fillColor === 'string' ? (entity.style as any).fillColor : '#eff6ff'
    const textColor = entity.style && typeof (entity.style as any).textColor === 'string' ? (entity.style as any).textColor : '#0f172a'

    if (entity.kind === 'rectangle' || entity.kind === 'ellipse' || entity.kind === 'diamond') {
      const bounds = getLayoutBounds(entity.id) || rawEntityBounds(entity)
      const currentWidth = Math.max(32, bounds.width * safeProgress)
      const currentHeight = Math.max(24, bounds.height * safeProgress)
      const offsetX = bounds.x + (bounds.width - currentWidth) / 2
      const offsetY = bounds.y + (bounds.height - currentHeight) / 2
      const shapeId = elementId('shape', entity.id)
      const labelText = entity.text || ''
      const fontSize = boundTextFontSize(bounds, labelText, 20)
      const textBox = textMetrics(labelText, fontSize)
      const elements: SceneElement[] = [
        baseElement(shapeId, entity.kind, offsetX, offsetY, currentWidth, currentHeight, {
          strokeColor,
          backgroundColor: fillColor,
          fillStyle: 'solid',
          strokeWidth: 2,
          opacity: Math.round(scaleBetween(26, 100, safeProgress)),
          roughness: 0.2,
        }),
      ]

      if (labelText) {
        elements.push(
          textElement(
            elementId('text', entity.id),
            bounds.x + (bounds.width - textBox.width) / 2,
            bounds.y + (bounds.height - textBox.height) / 2,
            labelText,
            fontSize,
            textColor,
            'center',
          ),
        )
      }

      return elements
    }

    if (entity.kind === 'triangle') {
      const bounds = getLayoutBounds(entity.id) || rawEntityBounds(entity)
      const currentWidth = Math.max(36, bounds.width * safeProgress)
      const currentHeight = Math.max(30, bounds.height * safeProgress)
      const offsetX = bounds.x + (bounds.width - currentWidth) / 2
      const offsetY = bounds.y + (bounds.height - currentHeight) / 2
      const trianglePoints: [number, number][] = [
        [offsetX + currentWidth / 2, offsetY],
        [offsetX + currentWidth, offsetY + currentHeight],
        [offsetX, offsetY + currentHeight],
        [offsetX + currentWidth / 2, offsetY],
      ]
      const normalized = normalizePoints(trianglePoints)
      const labelText = entity.text || ''
      const fontSize = boundTextFontSize(bounds, labelText, 18)
      const textBox = textMetrics(labelText, fontSize)
      const elements: SceneElement[] = [
        linearElement(
          elementId('shape', entity.id),
          'line',
          normalized.x,
          normalized.y,
          normalized.points,
          {
            strokeColor,
            backgroundColor: fillColor,
            fillStyle: 'solid',
            strokeWidth: 2,
            opacity: Math.round(scaleBetween(26, 100, safeProgress)),
            roughness: 0.2,
          },
        ),
      ]

      if (labelText) {
        elements.push(
          textElement(
            elementId('text', entity.id),
            bounds.x + (bounds.width - textBox.width) / 2,
            bounds.y + bounds.height * 0.48 - textBox.height / 2,
            labelText,
            fontSize,
            textColor,
            'center',
          ),
        )
      }

      return elements
    }

    if (entity.kind === 'text') {
      const bounds = getLayoutBounds(entity.id) || rawEntityBounds(entity)
      const fontSize = entity.style?.fontSize || 28
      const metrics = textMetrics(entity.text, fontSize)
      return [
        textElement(
          elementId('text', entity.id),
          bounds.x + (bounds.width - metrics.width) / 2,
          bounds.y + (bounds.height - metrics.height) / 2,
          entity.text,
          fontSize,
          entity.style?.strokeColor || '#0f172a',
          entity.style?.textAlign || 'center',
        ),
      ]
    }

    if (entity.kind === 'line') {
      const startX = entity.x1
      const startY = entity.y1
      const endX = scaleBetween(entity.x1, entity.x2, safeProgress)
      const endY = scaleBetween(entity.y1, entity.y2, safeProgress)
      const normalized = normalizePoints([
        [startX, startY],
        [endX, endY],
      ])
      const elements: SceneElement[] = [
        linearElement(
          elementId('line', entity.id),
          'line',
          normalized.x,
          normalized.y,
          normalized.points,
          {
            strokeColor,
            strokeWidth: 2,
            roughness: 0.1,
          },
        ),
      ]

      if (entity.text) {
        const label = entity.text
        const fontSize = 18
        const metrics = textMetrics(label, fontSize)
        elements.push(
          textElement(
            elementId('label', entity.id),
            (entity.x1 + entity.x2) / 2 - metrics.width / 2,
            (entity.y1 + entity.y2) / 2 - metrics.height - 8,
            label,
            fontSize,
            entity.style?.textColor || '#475569',
            'center',
          ),
        )
      }

      return elements
    }

    if (entity.kind === 'connector') {
      const fromBounds = getLayoutBounds(entity.from)
      const toBounds = getLayoutBounds(entity.to)
      if (!fromBounds || !toBounds) return []

      const rawStart = getEdgeDockPoint(fromBounds, toBounds)
      const rawEnd = getEdgeDockPoint(toBounds, fromBounds)
      const endX = scaleBetween(rawStart.x, rawEnd.x, safeProgress)
      const endY = scaleBetween(rawStart.y, rawEnd.y, safeProgress)
      const normalized = normalizePoints([
        [rawStart.x, rawStart.y],
        [endX, endY],
      ])
      const startElementId = getRenderedElementId(entity.from)
      const endElementId = getRenderedElementId(entity.to)
      const connectorId = elementId('connector', entity.id)
      const elements: SceneElement[] = [
        linearElement(
          connectorId,
          'arrow',
          normalized.x,
          normalized.y,
          normalized.points,
          {
            strokeColor,
            strokeWidth: 2,
            roughness: 0.1,
            startBinding: startElementId ? { elementId: startElementId, focus: 0, gap: 0 } : null,
            endBinding: endElementId ? { elementId: endElementId, focus: 0, gap: 0 } : null,
            startArrowhead: null,
            endArrowhead: entity.style?.arrow === false ? null : 'arrow',
          },
        ),
      ]

      if (entity.text) {
        const label = entity.text
        const fontSize = 18
        const metrics = textMetrics(label, fontSize)
        elements.push(
          textElement(
            elementId('connector-label', entity.id),
            (rawStart.x + rawEnd.x) / 2 - metrics.width / 2,
            (rawStart.y + rawEnd.y) / 2 - metrics.height - 10,
            label,
            fontSize,
            entity.style?.textColor || '#475569',
            'center',
          ),
        )
      }

      return elements
    }

    return []
  }

  const animateEntity = (entityId: string, progressBuilder: (progress: number) => SceneElement[], durationMs = 800) =>
    new Promise<void>((resolve) => {
      const start = performance.now()
      const step = (timestamp: number) => {
        const progress = clamp01((timestamp - start) / durationMs)
        upsertElements(progressBuilder(progress))
        syncScene(progress >= 1)
        if (progress >= 1) {
          state.frameHandle = null
          resolve()
          return
        }
        state.frameHandle = window.requestAnimationFrame(step)
      }

      state.frameHandle = window.requestAnimationFrame(step)
    })

  const drawEntity = async (entityId: string, durationMs = 900) => {
    const entity = state.plan?.board_template.entities?.[entityId]
    if (!entity || state.renderedEntityIds.has(entityId)) return

    await animateEntity(entityId, (progress) => buildEntityElements(entity, progress), durationMs)
    state.entityElementIds.set(entityId, buildEntityElements(entity, 1).map((element) => element.id))
    state.renderedEntityIds.add(entityId)

    if (entity.kind === 'connector') {
      state.connections.add(entityId)
      attachConnectorToShapes(elementId('connector', entity.id), entity.from, entity.to)
      syncScene(true)
    }
  }

  const highlightEntity = async (entityId: string, durationMs = 420) => {
    const bounds = entityBounds(entityId)
    if (!bounds) return
    const highlightId = elementId('highlight', entityId)
    state.activeHighlights.add(entityId)
    await animateEntity(
      entityId,
      (progress) => [
        {
          ...baseElement(highlightId, 'rectangle', bounds.x - 12, bounds.y - 12, bounds.width + 24, bounds.height + 24, {
            strokeColor: HIGHLIGHT_COLOR,
            backgroundColor: `${HIGHLIGHT_COLOR}22`,
            strokeWidth: 3,
            opacity: Math.round(scaleBetween(0, 85, progress)),
            roughness: 0.15,
          }),
        },
      ],
      durationMs,
    )
  }

  const eraseEntity = async (entityId: string) => {
    const ids = state.entityElementIds.get(entityId) || []
    const highlightId = elementId('highlight', entityId)
    removeElements([...ids, highlightId])
    state.entityElementIds.delete(entityId)
    state.renderedEntityIds.delete(entityId)
    state.connections.delete(entityId)
    state.activeHighlights.delete(entityId)
    syncScene(true)
  }

  return {
    loadPlan(plan: LessonPlan) {
      state.plan = plan
      state.sceneElements = []
      state.entityElementIds.clear()
      state.renderedEntityIds.clear()
      state.activeHighlights.clear()
      state.connections.clear()
      state.layoutBounds = resolveLayout(plan)
      syncScene(false)
    },
    reset() {
      if (state.frameHandle !== null) {
        window.cancelAnimationFrame(state.frameHandle)
        state.frameHandle = null
      }
      state.sceneElements = []
      state.entityElementIds.clear()
      state.renderedEntityIds.clear()
      state.activeHighlights.clear()
      state.connections.clear()
      state.layoutBounds.clear()
      syncScene(false)
    },
    async executeOp(op: TimelineOp) {
      const durationMs = op.duration_ms || 700
      switch (op.action) {
        case 'draw':
        case 'label':
        case 'connect':
          await drawEntity(op.entity, durationMs)
          return
        case 'highlight':
          await highlightEntity(op.entity, durationMs)
          return
        case 'erase':
          await eraseEntity(op.entity)
          return
        default:
      }
    },
  }
}
