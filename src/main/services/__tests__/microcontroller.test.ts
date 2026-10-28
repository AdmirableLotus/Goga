import { describe, expect, it } from 'vitest'
import { boardFor, checkProject, compileErrors, projectGuide } from '../microcontroller'
import { needsSignIn, pageText, schematikUrl } from '../schematik'
import { looksLikeAgentTask, plannerOffers } from '../agentRouting'

const BLINK = 'void setup() { pinMode(2, OUTPUT); }\nvoid loop() { digitalWrite(2, HIGH); delay(500); digitalWrite(2, LOW); delay(500); }'

describe('microcontroller projects', () => {
  it('knows the boards by everyday names', () => {
    expect(boardFor('esp32').fqbn).toBe('esp32:esp32:esp32')
    expect(boardFor('Arduino Uno').fqbn).toBe('arduino:avr:uno')
    expect(boardFor('ESP32 dev module').fqbn).toBe('esp32:esp32:esp32')
    expect(() => boardFor('toaster')).toThrow(/unknown board/)
  })

  it('catches mistakes before compiling', () => {
    expect(checkProject({ name: 'blink', board: 'esp32', code: BLINK })).toEqual([])
    const problems = checkProject({ name: '../x', board: 'toaster', code: 'int main() {}' }).join('\n')
    expect(problems).toMatch(/name must be/)
    expect(problems).toMatch(/unknown board/)
    expect(problems).toMatch(/setup\(\) and void loop\(\)/)
  })

  it('writes a build guide with parts to buy, wiring and steps', () => {
    const guide = projectGuide({
      name: 'plant-watch', board: 'esp32', code: BLINK,
      parts: [{ name: 'Soil sensor | capacitive', qty: 1 }],
      wiring: [{ from: 'Sensor AOUT', to: 'GPIO 34' }],
      steps: ['Plug the sensor in', 'Upload the code'],
    })
    expect(guide).toContain('Board: ESP32 Dev Module')
    expect(guide).toContain('| Soil sensor / capacitive | 1 |  |')
    expect(guide).toContain('| Sensor AOUT | GPIO 34 |  |')
    expect(guide).toContain('2. Upload the code')
  })

  it('keeps only the useful lines of a failed compile', () => {
    const out = 'Compiling...\nsketch.ino:3:5: error: \'foo\' was not declared in this scope\nUsed platform...'
    expect(compileErrors(out)).toBe('sketch.ino:3:5: error: \'foo\' was not declared in this scope')
  })
})

describe('Schematik', () => {
  it('reads only Schematik pages', () => {
    expect(schematikUrl('https://www.schematik.io/app/097b2e0d')).toBe('https://www.schematik.io/app/097b2e0d')
    expect(schematikUrl(undefined)).toBe('https://www.schematik.io/app')
    expect(() => schematikUrl('https://evil.example/schematik.io')).toThrow()
    expect(() => schematikUrl('http://www.schematik.io/app')).toThrow()
  })

  it('tells a sign-in page from a project', () => {
    expect(needsSignIn('https://www.schematik.io/login', 'Welcome')).toBe(true)
    expect(needsSignIn('https://www.schematik.io/app', 'Sign in to continue. Continue with Google')).toBe(true)
    expect(needsSignIn('https://www.schematik.io/app/1', `Wiring ${'x'.repeat(2000)} sign in`)).toBe(false)
    expect(pageText('a  b\n\n\n c').length).toBeLessThan(10)
  })
})

describe('routing hardware work', () => {
  it('sends board and Schematik work to the PC agent', () => {
    expect(looksLikeAgentTask('read my project on schematik.io')).toBe(true)
    expect(looksLikeAgentTask('upload the plant sketch to my esp32')).toBe(true)
    expect(looksLikeAgentTask('make an esp32 project that waters my plants')).toBe(true)
  })

  it('offers hardware tools only for hardware tasks, and Flux only when Flux is named', () => {
    const board = plannerOffers('make an ESP32 project with a DHT22')
    expect(board('microcontroller.build')).toBe(true)
    expect(board('electronics.findPart')).toBe(true)
    expect(board('flux.get_project')).toBe(false)
    expect(board('computer.click')).toBe(false)
    const other = plannerOffers('open notepad and save my notes')
    expect(other('microcontroller.build')).toBe(false)
    expect(other('schematik.read')).toBe(false)
  })
})
