import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { copyVideoAttachment } from '../../src/plugin/video-writer.js'

describe('copyVideoAttachment', () => {
  let tmpDir: string
  let outputDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qf-video-src-'))
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qf-video-out-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    fs.rmSync(outputDir, { recursive: true, force: true })
  })

  it('copies the video into outputDir and returns a relative localVideoPath', () => {
    const src = path.join(tmpDir, 'a.mp4')
    fs.writeFileSync(src, 'fake-video-bytes')

    const result = copyVideoAttachment(src, outputDir, 1_000_000)

    expect(result).toBeDefined()
    expect(result!.mimeType).toBe('video/mp4')
    expect(result!.fileSize).toBe('fake-video-bytes'.length)
    const copiedPath = path.join(outputDir, result!.localVideoPath)
    expect(fs.readFileSync(copiedPath, 'utf8')).toBe('fake-video-bytes')
  })

  it('skips an unsupported extension without touching outputDir', () => {
    const src = path.join(tmpDir, 'a.avi')
    fs.writeFileSync(src, 'x')

    const result = copyVideoAttachment(src, outputDir, 1_000_000)

    expect(result).toBeUndefined()
    expect(fs.readdirSync(outputDir)).toHaveLength(0)
  })

  it('skips a file exceeding maxVideoBytes without reading it', () => {
    const src = path.join(tmpDir, 'a.mp4')
    fs.writeFileSync(src, 'this-is-11-bytes')

    const result = copyVideoAttachment(src, outputDir, 5)

    expect(result).toBeUndefined()
    expect(fs.readdirSync(outputDir)).toHaveLength(0)
  })

  it('gives two videos copied into the same outputDir distinct filenames', () => {
    const srcA = path.join(tmpDir, 'a.mp4')
    const srcB = path.join(tmpDir, 'b.mp4')
    fs.writeFileSync(srcA, 'a')
    fs.writeFileSync(srcB, 'b')

    const resultA = copyVideoAttachment(srcA, outputDir, 1_000_000)
    const resultB = copyVideoAttachment(srcB, outputDir, 1_000_000)

    expect(resultA!.localVideoPath).not.toBe(resultB!.localVideoPath)
  })
})
