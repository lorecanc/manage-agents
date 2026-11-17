import { useEffect, useRef, useState } from "react"
import type { EasingFunctions } from "@opentui/core"
import { useTimeline } from "@opentui/react"
import { SPINNER_FRAMES } from "../utils/uiTheme.js"

export function isReducedMotionPreferred(configFlag?: boolean): boolean {
  if (configFlag === true) return true
  const env = process.env.AGENT_MANAGER_REDUCED_MOTION
  return env === "1" || env === "true"
}

export function useAnimatedNumber(
  target: number,
  options: { duration?: number; ease?: EasingFunctions; reducedMotion?: boolean } = {},
): number {
  const { duration = 150, ease = "outQuad", reducedMotion = false } = options
  const [value, setValue] = useState(target)
  const currentRef = useRef(target)
  const timeline = useTimeline({ duration, autoplay: false, loop: false })

  useEffect(() => {
    if (reducedMotion || Math.abs(currentRef.current - target) < 0.002) {
      timeline.pause()
      currentRef.current = target
      setValue(target)
      return
    }
    const startVal = currentRef.current
    timeline.pause()
    timeline.items = []
    timeline.duration = duration
    timeline.currentTime = 0
    timeline.isComplete = false
    timeline.add(
      { v: startVal },
      {
        v: target,
        duration,
        ease,
        onUpdate: (anim) => {
          const next = anim.targets[0]?.v ?? target
          currentRef.current = next
          setValue(next)
        },
        onComplete: () => {
          currentRef.current = target
          setValue(target)
        },
      },
      0,
    )
    timeline.play()
  }, [target, duration, ease, reducedMotion, timeline])

  return reducedMotion ? target : value
}

export function useFlashDecay(triggerCount: number, reducedMotion = false, duration = 420): number {
  const [intensity, setIntensity] = useState(0)
  const timeline = useTimeline({ duration, autoplay: false, loop: false })

  useEffect(() => {
    if (triggerCount <= 0) return
    if (reducedMotion) {
      timeline.pause()
      timeline.items = []
      setIntensity(0)
      return
    }
    timeline.pause()
    timeline.items = []
    timeline.duration = duration
    timeline.currentTime = 0
    timeline.isComplete = false
    setIntensity(1)
    timeline.add(
      { v: 1 },
      {
        v: 0,
        duration,
        ease: "outQuad",
        onUpdate: (anim) => {
          setIntensity(Math.max(0, anim.targets[0]?.v ?? 0))
        },
        onComplete: () => setIntensity(0),
      },
      0,
    )
    timeline.play()
  }, [triggerCount, duration, reducedMotion, timeline])

  return intensity
}

export function useToastCountdown(
  toastId: number,
  active: boolean,
  durationMs: number,
  reducedMotion: boolean,
  onExpire: () => void,
): number {
  const [remaining, setRemaining] = useState(1)
  const expireRef = useRef(onExpire)
  expireRef.current = onExpire
  const timeline = useTimeline({ duration: durationMs, autoplay: false, loop: false })

  useEffect(() => {
    if (!active || toastId <= 0) {
      timeline.pause()
      setRemaining(0)
      return
    }
    if (reducedMotion) {
      setRemaining(1)
      const timer = setTimeout(() => expireRef.current(), durationMs)
      return () => clearTimeout(timer)
    }
    timeline.pause()
    timeline.items = []
    timeline.duration = durationMs
    timeline.currentTime = 0
    timeline.isComplete = false
    setRemaining(1)
    timeline.add(
      { v: 1 },
      {
        v: 0,
        duration: durationMs,
        ease: "linear",
        onUpdate: (anim) => {
          setRemaining(Math.max(0, anim.targets[0]?.v ?? 0))
        },
        onComplete: () => {
          setRemaining(0)
          expireRef.current()
        },
      },
      0,
    )
    timeline.play()
    return () => {
      timeline.pause()
    }
  }, [toastId, active, durationMs, reducedMotion, timeline])

  return remaining
}

export function usePulseLoop(active: boolean, reducedMotion = false): { phase: number; spinner: string } {
  const [tick, setTick] = useState(0)
  const timeline = useTimeline({ duration: 900, autoplay: false, loop: true })

  useEffect(() => {
    if (!active || reducedMotion) {
      timeline.pause()
      setTick(0)
      return
    }
    timeline.pause()
    timeline.items = []
    timeline.duration = 900
    timeline.currentTime = 0
    timeline.isComplete = false
    timeline.add(
      { t: 0 },
      {
        t: 1,
        duration: 900,
        ease: "linear",
        onUpdate: (anim) => {
          setTick(anim.targets[0]?.t ?? 0)
        },
      },
      0,
    )
    timeline.play()
    return () => {
      timeline.pause()
    }
  }, [active, reducedMotion, timeline])

  if (!active) return { phase: 0, spinner: "" }
  if (reducedMotion) return { phase: 0.5, spinner: "◌" }
  const frameIndex = Math.floor(tick * SPINNER_FRAMES.length) % SPINNER_FRAMES.length
  const wave = 0.5 - 0.5 * Math.cos(tick * Math.PI * 2)
  return { phase: wave, spinner: SPINNER_FRAMES[frameIndex] }
}
