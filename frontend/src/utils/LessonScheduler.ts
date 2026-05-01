import { createBoardExecutor } from './BoardExecutor'
import type { LessonPlan, TimelineStep } from './teachingTemplates'

type SchedulerCallbacks = {
  onPhaseChange?: (phase: 'thinking' | 'speaking' | 'listening') => void
  onSpeechStart?: (text: string) => void
  onSpeechEnd?: () => void
  onStepStart?: (step: TimelineStep) => void
  onStepComplete?: (step: TimelineStep) => void
  onComplete?: () => void
}

type StepController = {
  releaseTo: (count: number) => void
  waitFor: (index: number) => Promise<void>
  finish: () => void
}

function createStepController(totalOps: number): StepController {
  let released = 0
  const waiters = new Map<number, Array<() => void>>()

  const flush = () => {
    for (const [index, resolvers] of Array.from(waiters.entries())) {
      if (index < released) {
        resolvers.forEach((resolve) => resolve())
        waiters.delete(index)
      }
    }
  }

  return {
    releaseTo(count: number) {
      released = Math.max(released, Math.min(totalOps, count))
      flush()
    },
    waitFor(index: number) {
      if (index < released) return Promise.resolve()
      return new Promise<void>((resolve) => {
        const existing = waiters.get(index) || []
        existing.push(resolve)
        waiters.set(index, existing)
      })
    },
    finish() {
      released = totalOps
      flush()
    },
  }
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value))
}

export function createLessonScheduler(excalidrawAPI: any, callbacks: SchedulerCallbacks = {}) {
  const executor = createBoardExecutor(excalidrawAPI)
  let plan: LessonPlan | null = null
  let cancelled = false
  let activeRun = 0
  const canUseSpeechSynthesis =
    typeof window !== 'undefined'
    && 'speechSynthesis' in window
    && typeof window.SpeechSynthesisUtterance === 'function'

  const cancelSpeech = () => {
    if (canUseSpeechSynthesis) {
      window.speechSynthesis.cancel()
    }
  }

  const paceOps = (controller: StepController, step: TimelineStep, runId: number) =>
    new Promise<void>((resolve) => {
      if (!step.ops.length) {
        resolve()
        return
      }

      const started = performance.now()
      const tick = (timestamp: number) => {
        if (cancelled || runId !== activeRun) {
          resolve()
          return
        }

        const progress = clamp01((timestamp - started) / Math.max(step.estimated_duration_ms, 1))
        const target = Math.max(1, Math.ceil(progress * step.ops.length))
        controller.releaseTo(target)

        if (progress >= 1) {
          resolve()
          return
        }

        window.requestAnimationFrame(tick)
      }

      controller.releaseTo(step.ops.length ? 1 : 0)
      window.requestAnimationFrame(tick)
    })

  const speakStep = (step: TimelineStep, controller: StepController, runId: number) =>
    new Promise<void>((resolve) => {
      if (cancelled || runId !== activeRun) {
        resolve()
        return
      }

      if (!canUseSpeechSynthesis) {
        callbacks.onSpeechStart?.(step.speech_text)
        callbacks.onSpeechEnd?.()
        controller.finish()
        resolve()
        return
      }

      callbacks.onPhaseChange?.('speaking')
      callbacks.onSpeechStart?.(step.speech_text)

      const utterance = new SpeechSynthesisUtterance(step.speech_text)
      utterance.rate = 0.95
      utterance.pitch = 1.02

      const totalLength = Math.max(step.speech_text.length, 1)
      let finished = false
      const fallbackTimer = window.setTimeout(() => {
        finish()
      }, step.estimated_duration_ms + 1500)

      const finish = () => {
        if (finished) return
        finished = true
        window.clearTimeout(fallbackTimer)
        callbacks.onSpeechEnd?.()
        controller.finish()
        resolve()
      }

      utterance.onboundary = (event: any) => {
        if (cancelled || runId !== activeRun || !step.ops.length) return
        const charIndex = Number.isFinite(event?.charIndex) ? event.charIndex : 0
        const fraction = clamp01(charIndex / totalLength)
        const target = Math.max(1, Math.ceil(fraction * step.ops.length))
        controller.releaseTo(target)
      }

      utterance.onend = finish
      utterance.onerror = finish

      try {
        window.speechSynthesis.cancel()
        window.speechSynthesis.speak(utterance)
      } catch {
        finish()
      }
    })

  const runStep = async (step: TimelineStep, runId: number) => {
    callbacks.onPhaseChange?.('speaking')
    callbacks.onStepStart?.(step)
    const controller = createStepController(step.ops.length)
    const pacePromise = paceOps(controller, step, runId)
    const drawPromise = (async () => {
      for (let index = 0; index < step.ops.length; index += 1) {
        await controller.waitFor(index)
        if (cancelled || runId !== activeRun) return
        await executor.executeOp(step.ops[index])
      }
    })()
    const speechPromise = speakStep(step, controller, runId)

    await Promise.all([pacePromise, drawPromise, speechPromise])

    if (!cancelled && runId === activeRun) {
      callbacks.onStepComplete?.(step)
    }
  }

  return {
    loadPlan(nextPlan: LessonPlan) {
      plan = nextPlan
      executor.loadPlan(nextPlan)
    },
    async start() {
      if (!plan) return
      cancelled = false
      activeRun += 1
      const runId = activeRun

      for (const step of plan.timeline) {
        if (cancelled || runId !== activeRun) return
        await runStep(step, runId)
      }

      if (!cancelled && runId === activeRun) {
        callbacks.onSpeechEnd?.()
        callbacks.onComplete?.()
      }
    },
    cancel({ resetBoard = true } = {}) {
      cancelled = true
      activeRun += 1
      cancelSpeech()
      if (resetBoard) {
        executor.reset()
      }
    },
    resetBoard() {
      executor.reset()
    },
  }
}
