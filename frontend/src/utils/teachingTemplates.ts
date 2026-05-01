export type TemplateEntity =
  | {
      id: string
      kind: 'rectangle' | 'ellipse' | 'diamond' | 'triangle'
      x: number
      y: number
      width: number
      height: number
      text?: string
      style?: {
        strokeColor?: string
        fillColor?: string
        textColor?: string
      }
    }
  | {
      id: string
      kind: 'text'
      x: number
      y: number
      text: string
      style?: {
        strokeColor?: string
        fontSize?: number
        textAlign?: 'left' | 'center' | 'right'
      }
    }
  | {
      id: string
      kind: 'line'
      x1: number
      y1: number
      x2: number
      y2: number
      text?: string
      style?: {
        strokeColor?: string
        textColor?: string
      }
    }
  | {
      id: string
      kind: 'connector'
      from: string
      to: string
      text?: string
      style?: {
        strokeColor?: string
        textColor?: string
        arrow?: boolean
      }
    }

export type TimelineOp = {
  action: 'draw' | 'highlight' | 'connect' | 'erase' | 'label'
  entity: string
  duration_ms?: number
}

export type TimelineStep = {
  step_number: number
  speech_text: string
  estimated_duration_ms: number
  ops: TimelineOp[]
}

export type LessonPlan = {
  topic: string
  mode: 'timeline'
  plan_version: number
  template_id: string
  speech?: {
    segments: Array<{
      step_number: number
      speech_text: string
      estimated_duration_ms: number
    }>
  }
  board_template: {
    entities: Record<string, TemplateEntity>
  }
  timeline: TimelineStep[]
}

const ACTIONS = new Set(['draw', 'highlight', 'connect', 'erase', 'label'])

type LegacyVisual = {
  id: string
  type: 'shape' | 'text' | 'line' | 'arrow'
  content: string
  position: { x: number; y: number }
  style: { color: string; highlight: boolean }
}

function splitIntoSpeechSteps(value: unknown) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) return []

  return text
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
}

function normalizeLegacyVisual(input: any, index: number): LegacyVisual | null {
  if (!input || typeof input !== 'object') return null
  if (input.type !== 'shape' && input.type !== 'text' && input.type !== 'line' && input.type !== 'arrow') return null

  return {
    id: normalizeText(input.id, `legacy_visual_${index + 1}`),
    type: input.type,
    content: typeof input.content === 'string' ? input.content : '',
    position: {
      x: toFiniteNumber(input.position?.x, 180 + (index % 4) * 150),
      y: toFiniteNumber(input.position?.y, 180 + Math.floor(index / 4) * 110),
    },
    style: {
      color: normalizeText(input.style?.color, '#2563eb'),
      highlight: Boolean(input.style?.highlight),
    },
  }
}

function legacyVisualToEntity(visual: LegacyVisual): TemplateEntity {
  if (visual.type === 'text') {
    return {
      id: visual.id,
      kind: 'text',
      x: visual.position.x,
      y: visual.position.y,
      text: visual.content || visual.id,
      style: {
        strokeColor: visual.style.color,
        fontSize: visual.style.highlight ? 28 : 24,
        textAlign: 'center',
      },
    }
  }

  if (visual.type === 'line' || visual.type === 'arrow') {
    return {
      id: visual.id,
      kind: 'line',
      x1: visual.position.x,
      y1: visual.position.y,
      x2: visual.position.x + 120,
      y2: visual.position.y,
      text: visual.content,
      style: {
        strokeColor: visual.style.color,
        textColor: '#64748b',
      },
    }
  }

  return {
    id: visual.id,
    kind: 'rectangle',
    x: visual.position.x,
    y: visual.position.y,
    width: 120,
    height: 68,
    text: visual.content,
    style: {
      strokeColor: visual.style.color,
      fillColor: visual.style.highlight ? '#eff6ff' : '#ffffff',
      textColor: '#0f172a',
    },
  }
}

function buildTimelineFromLegacyVisuals(input: any, speechSteps: string[]): LessonPlan | null {
  const visuals = Array.isArray(input?.visuals)
    ? input.visuals
        .map((visual: any, index: number) => normalizeLegacyVisual(visual, index))
        .filter(Boolean) as LegacyVisual[]
    : []

  if (!visuals.length) return null

  const entities = Object.fromEntries(
    visuals.map((visual) => [visual.id, legacyVisualToEntity(visual)]),
  ) as Record<string, TemplateEntity>

  const cueSteps = Array.isArray(input?.sync) ? input.sync : []
  const timeline = cueSteps.length
    ? cueSteps.map((cue: any, index: number) => {
        const cueVisuals = Array.isArray(cue?.visuals)
          ? cue.visuals
              .map((visual: any, visualIndex: number) => normalizeLegacyVisual(visual, visualIndex))
              .filter((visual): visual is LegacyVisual => Boolean(visual) && Boolean(entities[visual.id]))
          : []
        const sentence = normalizeText(cue?.sentence, speechSteps[index] || `Step ${index + 1}.`)
        const highlightIds = Array.isArray(cue?.highlightIds)
          ? cue.highlightIds.filter((id: any) => typeof id === 'string' && entities[id])
          : []

        return {
          step_number: index + 1,
          speech_text: sentence,
          estimated_duration_ms: Math.max(2200, sentence.split(/\s+/).filter(Boolean).length * 360),
          ops: [
            ...cueVisuals.map((visual) => ({ action: 'draw' as const, entity: visual.id })),
            ...highlightIds.map((entityId: string) => ({ action: 'highlight' as const, entity: entityId })),
          ],
        }
      })
    : speechSteps.map((step, index) => {
        const visual = visuals[index]
        return {
          step_number: index + 1,
          speech_text: step,
          estimated_duration_ms: Math.max(2200, step.split(/\s+/).filter(Boolean).length * 360),
          ops: visual
            ? [
                { action: 'draw' as const, entity: visual.id },
                ...(visual.style.highlight ? [{ action: 'highlight' as const, entity: visual.id }] : []),
              ]
            : [],
        }
      })

  if (!timeline.length) return null

  return {
    topic: normalizeText(input?.topic, 'Lesson'),
    mode: 'timeline',
    plan_version: 1,
    template_id: 'legacy.visuals.compatibility.v1',
    speech: {
      segments: timeline.map((step) => ({
        step_number: step.step_number,
        speech_text: step.speech_text,
        estimated_duration_ms: step.estimated_duration_ms,
      })),
    },
    board_template: { entities },
    timeline,
  }
}

function buildLegacyLessonPlan(input: any): LessonPlan | null {
  if (!input || typeof input !== 'object') return null

  const speechSteps = splitIntoSpeechSteps(input.chat)
  if (!speechSteps.length) return null

  const visualsPlan = buildTimelineFromLegacyVisuals(input, speechSteps)
  if (visualsPlan) return visualsPlan

  const title = normalizeText(input.topic, 'Lesson')
  const summary = speechSteps[0]
  const detail = speechSteps[1] || 'Let us build the idea step by step.'
  const takeaway = speechSteps.slice(2).join(' ') || 'This is the main takeaway.'

  const entities: Record<string, TemplateEntity> = {
    topic_title: {
      id: 'topic_title',
      kind: 'text',
      x: 420,
      y: 80,
      text: title,
      style: {
        strokeColor: '#0f172a',
        fontSize: 34,
        textAlign: 'center',
      },
    },
    concept_box: {
      id: 'concept_box',
      kind: 'rectangle',
      x: 230,
      y: 180,
      width: 380,
      height: 140,
      text: summary,
      style: {
        strokeColor: '#2563eb',
        fillColor: '#eff6ff',
        textColor: '#0f172a',
      },
    },
    detail_box: {
      id: 'detail_box',
      kind: 'rectangle',
      x: 120,
      y: 380,
      width: 270,
      height: 110,
      text: detail,
      style: {
        strokeColor: '#0ea5e9',
        fillColor: '#ecfeff',
        textColor: '#0f172a',
      },
    },
    takeaway_box: {
      id: 'takeaway_box',
      kind: 'rectangle',
      x: 470,
      y: 380,
      width: 270,
      height: 110,
      text: takeaway,
      style: {
        strokeColor: '#16a34a',
        fillColor: '#ecfdf5',
        textColor: '#0f172a',
      },
    },
    detail_link: {
      id: 'detail_link',
      kind: 'connector',
      from: 'concept_box',
      to: 'detail_box',
      text: 'detail',
      style: {
        strokeColor: '#0ea5e9',
        textColor: '#0369a1',
        arrow: true,
      },
    },
    takeaway_link: {
      id: 'takeaway_link',
      kind: 'connector',
      from: 'concept_box',
      to: 'takeaway_box',
      text: 'result',
      style: {
        strokeColor: '#16a34a',
        textColor: '#166534',
        arrow: true,
      },
    },
  }

  return {
    topic: title,
    mode: 'timeline',
    plan_version: 1,
    template_id: 'legacy.compatibility.v1',
    speech: {
      segments: speechSteps.map((step, index) => ({
        step_number: index + 1,
        speech_text: step,
        estimated_duration_ms: Math.max(2200, step.split(/\s+/).filter(Boolean).length * 360),
      })),
    },
    board_template: { entities },
    timeline: [
      {
        step_number: 1,
        speech_text: summary,
        estimated_duration_ms: Math.max(2200, summary.split(/\s+/).filter(Boolean).length * 360),
        ops: [
          { action: 'label', entity: 'topic_title' },
          { action: 'draw', entity: 'concept_box' },
          { action: 'highlight', entity: 'concept_box' },
        ],
      },
      {
        step_number: 2,
        speech_text: detail,
        estimated_duration_ms: Math.max(2200, detail.split(/\s+/).filter(Boolean).length * 360),
        ops: [
          { action: 'draw', entity: 'detail_box' },
          { action: 'connect', entity: 'detail_link' },
          { action: 'highlight', entity: 'detail_box' },
        ],
      },
      {
        step_number: 3,
        speech_text: takeaway,
        estimated_duration_ms: Math.max(2200, takeaway.split(/\s+/).filter(Boolean).length * 360),
        ops: [
          { action: 'draw', entity: 'takeaway_box' },
          { action: 'connect', entity: 'takeaway_link' },
          { action: 'highlight', entity: 'takeaway_box' },
        ],
      },
    ],
  }
}

function toFiniteNumber(value: unknown, fallback: number) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback
}

function normalizeText(value: unknown, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function normalizeEntity(entityId: string, value: any): TemplateEntity | null {
  if (!value || typeof value !== 'object' || typeof value.kind !== 'string') return null

  if (value.kind === 'rectangle' || value.kind === 'ellipse' || value.kind === 'diamond' || value.kind === 'triangle') {
    return {
      id: entityId,
      kind: value.kind,
      x: toFiniteNumber(value.x, 240),
      y: toFiniteNumber(value.y, 180),
      width: toFiniteNumber(value.width, 160),
      height: toFiniteNumber(value.height, 90),
      text: normalizeText(value.text),
      style: {
        strokeColor: normalizeText(value.style?.strokeColor, '#2563eb'),
        fillColor: normalizeText(value.style?.fillColor, '#ffffff'),
        textColor: normalizeText(value.style?.textColor, '#0f172a'),
      },
    }
  }

  if (value.kind === 'text') {
    return {
      id: entityId,
      kind: 'text',
      x: toFiniteNumber(value.x, 240),
      y: toFiniteNumber(value.y, 180),
      text: normalizeText(value.text, entityId),
      style: {
        strokeColor: normalizeText(value.style?.strokeColor, '#0f172a'),
        fontSize: toFiniteNumber(value.style?.fontSize, 28),
        textAlign: value.style?.textAlign === 'left' || value.style?.textAlign === 'right' ? value.style.textAlign : 'center',
      },
    }
  }

  if (value.kind === 'line') {
    return {
      id: entityId,
      kind: 'line',
      x1: toFiniteNumber(value.x1, 240),
      y1: toFiniteNumber(value.y1, 200),
      x2: toFiniteNumber(value.x2, 360),
      y2: toFiniteNumber(value.y2, 200),
      text: normalizeText(value.text),
      style: {
        strokeColor: normalizeText(value.style?.strokeColor, '#2563eb'),
        textColor: normalizeText(value.style?.textColor, '#64748b'),
      },
    }
  }

  if (value.kind === 'connector') {
    return {
      id: entityId,
      kind: 'connector',
      from: normalizeText(value.from),
      to: normalizeText(value.to),
      text: normalizeText(value.text),
      style: {
        strokeColor: normalizeText(value.style?.strokeColor, '#64748b'),
        textColor: normalizeText(value.style?.textColor, '#64748b'),
        arrow: value.style?.arrow !== false,
      },
    }
  }

  return null
}

export function validateLessonPlan(input: any): LessonPlan | null {
  const candidate =
    input && typeof input === 'object' && input.mode === 'timeline'
      ? input
      : buildLegacyLessonPlan(input)

  if (!candidate || typeof candidate !== 'object' || candidate.mode !== 'timeline') return null

  const rawEntities = candidate.board_template?.entities
  if (!rawEntities || typeof rawEntities !== 'object') return null

  const entities = Object.fromEntries(
    Object.entries(rawEntities)
      .map(([entityId, value]) => [entityId, normalizeEntity(entityId, value)])
      .filter(([, value]) => Boolean(value)),
  ) as Record<string, TemplateEntity>

  if (!Object.keys(entities).length) return null
  if (!Array.isArray(candidate.timeline) || !candidate.timeline.length) return null

  const timeline = candidate.timeline
    .map((step: any, index: number) => {
      const ops = Array.isArray(step?.ops)
        ? step.ops
            .filter((op: any) => ACTIONS.has(op?.action) && typeof op?.entity === 'string' && entities[op.entity])
            .map((op: any) => ({
              action: op.action,
              entity: op.entity,
              duration_ms: Number.isFinite(Number(op.duration_ms)) ? Number(op.duration_ms) : undefined,
            }))
        : []

      return {
        step_number: toFiniteNumber(step?.step_number, index + 1),
        speech_text: normalizeText(step?.speech_text, `Step ${index + 1}.`),
        estimated_duration_ms: Math.max(2200, toFiniteNumber(step?.estimated_duration_ms, 3200)),
        ops,
      }
    })
    .filter((step) => step.speech_text)

  if (!timeline.length) return null

  return {
    topic: normalizeText(candidate.topic, 'Lesson'),
    mode: 'timeline',
    plan_version: toFiniteNumber(candidate.plan_version, 1),
    template_id: normalizeText(candidate.template_id, 'generic.concept_box.v1'),
    speech: {
      segments: timeline.map((step) => ({
        step_number: step.step_number,
        speech_text: step.speech_text,
        estimated_duration_ms: step.estimated_duration_ms,
      })),
    },
    board_template: { entities },
    timeline,
  }
}