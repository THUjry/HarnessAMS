// HarnessAMS project self-check verification (compute step, JavaScript channel).
//
// Pointwise comparison — the JS twin of selfcheck_verify.py with the SAME output
// contract (last stdout line `[selfcheck] {json}`; exit 0 whenever the
// computation completed, 2 on usage/IO trouble). Two execution modes:
//   - in-process: the local self-check orchestrator imports verifyRun() directly
//     (compute_script_local = "js" — no external interpreter needed locally);
//   - CLI: `node selfcheck_verify.mjs --run-dir . --topo lpf` on a REMOTE host
//     (compute_script_remote = "js" — requires node on the remote machine).
//
// For every sweep point the magnitude of every AC frequency sample is compared
// against the analytic RC response (LPF 1/sqrt(1+(f/fc)^2), HPF (f/fc)/...,
// fc = 1/(2*pi*R*C) from the point's point_meta.json params); a point passes
// when all samples stay within the tolerance (default 1%).
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const SI_SUFFIX = [
  ['t', 1e12], ['g', 1e9], ['meg', 1e6], ['k', 1e3],
  ['m', 1e-3], ['u', 1e-6], ['n', 1e-9], ['p', 1e-12], ['f', 1e-15],
]

export function siValue(text) {
  const s = String(text).trim()
  const n = Number(s)
  if (s !== '' && Number.isFinite(n)) return n
  const low = s.toLowerCase()
  for (const [suffix, factor] of SI_SUFFIX) {
    if (low.endsWith(suffix)) {
      const v = Number(low.slice(0, -suffix.length))
      if (Number.isFinite(v)) return v * factor
    }
  }
  throw new Error(`not an SI number: ${JSON.stringify(text)}`)
}

function theoryMag(topo, freq, r, c) {
  const fc = 1 / (2 * Math.PI * r * c)
  const x = freq / fc
  if (topo === 'lpf') return 1 / Math.sqrt(1 + x * x)
  return x / Math.sqrt(1 + x * x)
}

function loadCurve(csvPath) {
  const text = fs.readFileSync(csvPath, 'utf8')
  const lines = text.split(/\r?\n/)
  const header = (lines[0] ?? '').trim()
  if (header !== 'point,signal,index,sweep_value,re,im') {
    throw new Error(`unexpected CSV header in ${csvPath}: ${JSON.stringify(header)}`)
  }
  const curves = {}
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue
    const parts = line.split(',')
    if (parts.length < 6) continue
    const [, signal, idx, , reText, imText] = parts
    const series = (curves[signal] ??= {})
    series[Number(idx)] = [Number(reText), imText.trim() === '' ? null : Number(imText)]
  }
  return curves
}

function pointNames(runDir) {
  return fs.readdirSync(runDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^\d{2,}$/.test(e.name))
    .map((e) => e.name)
    .sort()
}

export function verifyRun(runDir, topo, tolerance = 0.01) {
  const abs = path.resolve(String(runDir))
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    throw new Error(`run dir does not exist: ${abs}`)
  }
  const points = []
  let maxRel = 0
  let failed = 0
  for (const name of pointNames(abs)) {
    const meta = JSON.parse(fs.readFileSync(path.join(abs, name, 'point_meta.json'), 'utf8'))
    const params = meta.params ?? {}
    const r = siValue(params.r_val)
    const c = siValue(params.c_val)
    const curves = loadCurve(path.join(abs, 'psf', `${name}_psf.csv`))
    const freqSeries = curves.ac_freq
    const voutSeries = curves.ac_vout
    if (!freqSeries || !voutSeries) throw new Error(`missing ac_freq/ac_vout curves for point ${name}`)
    let pointMax = 0
    let worstFreq = null
    let n = 0
    for (const idx of Object.keys(freqSeries).map(Number).sort((a, b) => a - b)) {
      if (!(idx in voutSeries)) continue
      const freq = freqSeries[idx][0]
      const [reV, imV] = voutSeries[idx]
      const mag = Math.hypot(reV, imV ?? 0)
      const theory = theoryMag(topo, freq, r, c)
      const rel = Math.abs(mag - theory) / theory
      n += 1
      if (rel > pointMax) { pointMax = rel; worstFreq = freq }
    }
    const ok = pointMax <= tolerance
    if (!ok) failed += 1
    maxRel = Math.max(maxRel, pointMax)
    points.push({
      point: name,
      r: String(params.r_val),
      c: String(params.c_val),
      n_freq: n,
      fc_hz: 1 / (2 * Math.PI * r * c),
      max_rel_err: pointMax,
      worst_freq_hz: worstFreq,
      pass: ok,
    })
  }
  return {
    ok: failed === 0 && points.length > 0,
    topo,
    tolerance,
    points,
    max_rel_err: maxRel,
    failed_points: failed,
  }
}

function cli(argv) {
  const args = { tolerance: 0.01 }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--run-dir') args.runDir = argv[++i]
    else if (argv[i] === '--topo') args.topo = argv[++i]
    else if (argv[i] === '--tolerance') args.tolerance = Number(argv[++i])
    else {
      process.stderr.write(`selfcheck_verify.mjs: unknown argument ${argv[i]}\n`)
      process.exit(2)
    }
  }
  if (!args.runDir || !['lpf', 'hpf'].includes(args.topo)) {
    process.stderr.write('usage: node selfcheck_verify.mjs --run-dir <dir> --topo lpf|hpf [--tolerance 0.01]\n')
    process.exit(2)
  }
  let result
  try {
    result = verifyRun(args.runDir, args.topo, args.tolerance)
  } catch (e) {
    process.stderr.write(`selfcheck_verify.mjs: ${e?.message ?? e}\n`)
    process.exit(2)
  }
  process.stdout.write(`points=${result.points.length} failed=${result.failed_points} max_rel_err=${result.max_rel_err.toExponential(3)}\n`)
  process.stdout.write(`[selfcheck] ${JSON.stringify(result)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli(process.argv.slice(2))
}
