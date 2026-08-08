import React, { useRef, useEffect, useState } from 'react'
import { useGogaScene } from './useGogaScene'
import { GogaGestureController } from './GogaGestureController'
import type { GestureEvent } from './GogaGestureController'
import { useGogaVisual } from '../../context/GogaVisualContext'
import type { GogaVisualState } from './GogaVisualState'

const STATE_LABEL: Record<GogaVisualState, string> = {
  idle:            'IDLE',
  listening:       'LISTENING',
  transcribing:    'TRANSCRIBING',
  thinking:        'THINKING',
  acting:          'ACTING',
  seeing:          'SEEING',
  searching:       'SEARCHING',
  speaking:        'SPEAKING',
  waitingApproval: 'AWAITING APPROVAL',
  success:         'DONE',
  error:           'ERROR',
  stopped:         'STOPPED',
}

const STATE_COLOR: Record<GogaVisualState, string> = {
  idle:            '#8b5cff',
  listening:       '#29d9ff',
  transcribing:    '#00aadd',
  thinking:        '#b794ff',
  acting:          '#8b5cff',
  seeing:          '#29d9ff',
  searching:       '#8b5cff',
  speaking:        '#b794ff',
  waitingApproval: '#ffaa22',
  success:         '#00ffcc',
  error:           '#ff2244',
  stopped:         '#443355',
}

export default function GogaTriangleScene({ compact = false }: { compact?: boolean }) {
  const canvasRef  = useRef<HTMLCanvasElement>(null)
  const videoRef   = useRef<HTMLVideoElement>(null)
  const gestureRef = useRef<GogaGestureController | null>(null)
  const [gestureOn,  setGestureOn]  = useState(false)
  const [gestureErr, setGestureErr] = useState('')

  const { visualState, audioAmplitude, setVisualState } = useGogaVisual()
  const { rotateBy, scaleBy } = useGogaScene(
    canvasRef as React.RefObject<HTMLCanvasElement>,
    visualState,
    audioAmplitude
  )

  useEffect(() => {
    if (!gestureOn || !videoRef.current) return
    const ctrl = new GogaGestureController({
      wasmPath:  '/mediapipe',
      modelPath: '/mediapipe/hand_landmarker.task',
      onGesture: (e: GestureEvent) => {
        if (e.type === 'rotate') rotateBy(e.deltaY)
        else if (e.type === 'scale') scaleBy(e.factor)
        else if (e.type === 'listen') setVisualState('listening')
        else if (e.type === 'stop') {
          window.goga.invoke('agent:stop')
          window.goga.invoke('action:stop')
          setVisualState('stopped')
        }
      },
    })
    gestureRef.current = ctrl
    ctrl.start(videoRef.current).catch(err => {
      setGestureErr(String(err))
      setGestureOn(false)
    })
    return () => { ctrl.stop(); gestureRef.current = null }
  }, [gestureOn, rotateBy, scaleBy, setVisualState])

  const color = STATE_COLOR[visualState]

  const handleCoreClick = () => {
    if (visualState === 'idle') setVisualState('listening')
    else if (visualState === 'listening') setVisualState('idle')
    else setVisualState('idle')
  }

  return (
    <div style={styles.wrap}>
      <canvas ref={canvasRef} style={{ ...styles.canvas, cursor: 'pointer' }} onClick={handleCoreClick} />

      {!compact && (
        <div style={{ ...styles.badge, color, borderColor: color + '55' }}>
          <span style={{ ...styles.dot, background: color }} />
          {STATE_LABEL[visualState]}
        </div>
      )}

      {!compact && (
        <button
          style={{ ...styles.gestureBtn, color: gestureOn ? color : '#444', borderColor: gestureOn ? color + '88' : '#333' }}
          onClick={() => { setGestureOn(v => !v); setGestureErr('') }}
          title="Toggle hand gesture control"
        >
          ✋
        </button>
      )}

      {gestureErr && <div style={styles.errMsg}>{gestureErr}</div>}
      <video ref={videoRef} style={{ display: 'none' }} muted playsInline />
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    position: 'relative',
    width: '100%',
    height: '100%',
    background: '#06050e',
  },
  canvas: {
    display: 'block',
    width: '100%',
    height: '100%',
  },
  badge: {
    position: 'absolute',
    bottom: 10,
    left: '50%',
    transform: 'translateX(-50%)',
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: 2.5,
    padding: '3px 12px',
    border: '1px solid',
    borderRadius: 2,
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    background: 'rgba(6,5,14,0.8)',
    backdropFilter: 'blur(6px)',
    pointerEvents: 'none',
    transition: 'color 0.5s, border-color 0.5s',
    whiteSpace: 'nowrap',
  },
  dot: {
    width: 5, height: 5,
    borderRadius: '50%',
    flexShrink: 0,
    transition: 'background 0.5s',
  },
  gestureBtn: {
    position: 'absolute',
    top: 8, right: 8,
    background: 'rgba(6,5,14,0.8)',
    border: '1px solid',
    borderRadius: 4,
    fontSize: 13,
    padding: '3px 7px',
    cursor: 'pointer',
    transition: 'color 0.3s, border-color 0.3s',
  },
  errMsg: {
    position: 'absolute',
    bottom: 32,
    left: 8, right: 8,
    fontSize: 9,
    color: '#ff4444',
    textAlign: 'center',
    background: 'rgba(0,0,0,0.7)',
    padding: '2px 6px',
    borderRadius: 3,
  },
}
