/**
 * Drawing Engine — converts AI step instructions into Excalidraw elements.
 *
 * Architecture:
 *   AI steps → animateSteps() → interpretStep() → generateXxx() → excalidrawAPI.updateScene()
 *
 * Each generator returns an array of Excalidraw element objects and mutates
 * the shared `context` cursor so subsequent shapes don't overlap.
 */

const DELAY_MS = 500

// ─── Helpers ────────────────────────────────────────────────────────────────

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Build the mandatory base fields every Excalidraw element must have. */
function baseElement(type, x, y, width, height, overrides = {}) {
  return {
    id: crypto.randomUUID(),
    type,
    x,
    y,
    width,
    height,
    strokeColor: '#1e293b',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 1,
    opacity: 100,
    angle: 0,
    seed: Math.floor(Math.random() * 100000),
    version: 1,
    versionNonce: Math.floor(Math.random() * 100000),
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

/** Text element — extends baseElement with text-specific fields. */
function textElement(x, y, text, fontSize = 18, color = '#1e293b') {
  // Estimate width from text length and font size
  const width = Math.max(text.length * fontSize * 0.6, 60)
  const height = fontSize * 1.5
  return {
    ...baseElement('text', x, y, width, height),
    text,
    originalText: text,
    fontSize,
    fontFamily: 1,
    textAlign: 'left',
    verticalAlign: 'top',
    containerId: null,
    autoResize: true,
    lineHeight: 1.25,
    strokeColor: color,
  }
}

/** Line element — points are relative to the element's (x, y) origin. */
function lineElement(x, y, points, overrides = {}) {
  const xs = points.map((p) => p[0])
  const ys = points.map((p) => p[1])
  const width = Math.max(...xs) - Math.min(...xs) || 1
  const height = Math.max(...ys) - Math.min(...ys) || 1
  return {
    ...baseElement('line', x, y, width, height),
    points,
    lastCommittedPoint: null,
    startBinding: null,
    endBinding: null,
    startArrowhead: null,
    endArrowhead: null,
    ...overrides,
  }
}

// ─── Shape Generators ────────────────────────────────────────────────────────

/** Right triangle: 3 lines forming a right-angle triangle — purple strokes. */
function generateTriangle(context) {
  const { x, y } = context
  const W = 150
  const H = 120
  const bx = x
  const by = y + H

  const elements = [
    lineElement(bx, by, [[0, 0], [W, 0]], { strokeColor: '#7c3aed', strokeWidth: 2.5 }),
    lineElement(bx + W, by - H, [[0, 0], [0, H]], { strokeColor: '#7c3aed', strokeWidth: 2.5 }),
    lineElement(bx, by, [[0, 0], [W, -H]], { strokeColor: '#7c3aed', strokeWidth: 2.5 }),
  ]

  context.y += H + 50
  return elements
}

/** Single rectangle — blue fill. */
function generateRectangle(context) {
  const { x, y } = context
  const el = baseElement('rectangle', x, y, 160, 100, {
    strokeColor: '#1e40af',
    backgroundColor: '#dbeafe',
    fillStyle: 'solid',
    strokeWidth: 2,
  })
  context.y += 150
  return [el]
}

/** Single circle (ellipse) — green fill. */
function generateCircle(context) {
  const { x, y } = context
  const el = baseElement('ellipse', x, y, 120, 120, {
    strokeColor: '#15803d',
    backgroundColor: '#dcfce7',
    fillStyle: 'solid',
    strokeWidth: 2,
  })
  context.y += 170
  return [el]
}

/**
 * Labels — places text values horizontally near the current cursor.
 * step.values = ["a", "b", "c"]
 */
function generateLabel(step, context) {
  const values = Array.isArray(step.values) ? step.values : []
  const elements = values.map((val, i) =>
    textElement(context.x + i * 80, context.y, String(val), 20)
  )
  context.y += 60
  return elements
}

/**
 * Formula — dark amber text displayed below previous shapes.
 * step.value = "a^2 + b^2 = c^2"
 */
function generateFormula(step, context) {
  const text = step.value ? String(step.value) : '?'
  const el = textElement(context.x, context.y, text, 28, '#b45309')
  context.y += 70
  return [el]
}

/**
 * Array — a row of alternating-colored numbered boxes.
 * step.values = [3, 1, 4, 1, 5] or ["a", "b", "c"]
 */
function generateArray(step, context) {
  const values = Array.isArray(step.values) ? step.values : []
  const cellSize = 50
  const gap = 4
  const elements = []

  values.forEach((val, i) => {
    const cx = context.x + i * (cellSize + gap)
    const cy = context.y
    const isEven = i % 2 === 0
    elements.push(baseElement('rectangle', cx, cy, cellSize, cellSize, {
      strokeColor: isEven ? '#0369a1' : '#7c2d12',
      backgroundColor: isEven ? '#e0f2fe' : '#ffedd5',
      fillStyle: 'solid',
      strokeWidth: 2,
    }))
    elements.push(
      textElement(cx + 15, cy + 13, String(val), 16, '#1e293b')
    )
  })

  context.y += cellSize + 50
  return elements
}

/**
 * Highlight — semi-transparent amber rectangle overlaid at current cursor.
 * Does NOT advance context.y (it's an overlay).
 */
function generateHighlight(context) {
  const el = {
    ...baseElement('rectangle', context.x - 5, context.y - 5, 170, 60),
    backgroundColor: '#fbbf24',
    strokeColor: 'transparent',
    fillStyle: 'solid',
    opacity: 40,
  }
  return [el]
}

/**
 * Arrow — draws a right-pointing red arrow from current cursor position.
 * step.label = optional string label above arrow
 */
function generateArrow(step, context) {
  const { x, y } = context
  const length = 120
  const elements = []

  elements.push({
    ...baseElement('arrow', x, y, length, 1, {
      strokeColor: '#dc2626',
      strokeWidth: 2.5,
      roughness: 0,
    }),
    points: [[0, 0], [length, 0]],
    lastCommittedPoint: null,
    startBinding: null,
    endBinding: null,
    startArrowhead: null,
    endArrowhead: 'arrow',
  })

  if (step.label) {
    elements.push(textElement(x, y - 24, String(step.label), 14, '#dc2626'))
  }

  context.y += 50
  return elements
}

// ─── Interpreter ─────────────────────────────────────────────────────────────

/**
 * Converts a single step object into an array of Excalidraw elements.
 * Mutates `context` to advance the drawing cursor.
 */
export function interpretStep(step, context) {
  if (!step || typeof step.type !== 'string') {
    console.warn('[DrawingEngine] Invalid step — missing type:', step)
    return []
  }

  switch (step.type) {
    case 'draw': {
      const shape = (step.shape || '').toLowerCase()
      switch (shape) {
        case 'triangle':  return generateTriangle(context)
        case 'rectangle': return generateRectangle(context)
        case 'circle':    return generateCircle(context)
        default:
          console.warn(`[DrawingEngine] Unknown draw shape: "${step.shape}"`)
          return []
      }
    }
    case 'label':     return generateLabel(step, context)
    case 'formula':   return generateFormula(step, context)
    case 'array':     return generateArray(step, context)
    case 'highlight': return generateHighlight(context)
    case 'arrow':     return generateArrow(step, context)
    default:
      console.warn(`[DrawingEngine] Unknown step type: "${step.type}"`)
      return []
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Animates a list of AI steps onto the Excalidraw canvas with a delay between each.
 *
 * @param {Array}  steps           - Array of step objects from the AI response
 * @param {object} excalidrawAPI   - Excalidraw imperative API ref value
 * @param {Function} [onStepDone] - Optional callback called after each step renders
 */
export async function animateSteps(steps, excalidrawAPI, onStepDone) {
  if (!excalidrawAPI || !Array.isArray(steps)) return

  const context = { x: 60, y: 60 }

  for (const step of steps) {
    let newElements
    try {
      newElements = interpretStep(step, context)
    } catch (err) {
      console.error('[DrawingEngine] Error interpreting step:', step, err)
      continue
    }

    if (!newElements || newElements.length === 0) continue

    try {
      const existing = excalidrawAPI.getSceneElements()
      excalidrawAPI.updateScene({
        elements: [...existing, ...newElements],
      })
      excalidrawAPI.scrollToContent(newElements, {
        fitToContent: true,
        animate: true,
        duration: 400,
        minZoom: 0.5,
        maxZoom: 1.5,
      })
    } catch (err) {
      console.error('[DrawingEngine] Error updating scene:', err)
    }

    if (onStepDone) onStepDone(step)
    await delay(DELAY_MS)
  }
}
