"""Original background score for the mesh film (numpy synthesis, no samples).

96 BPM, 4/4: one bar = 2.5 s, one scene = 8 bars = 20 s. Scene k starts at film time 20k - 0.4 s
(the recording is trimmed 0.4 s into scene 1), so the score is rendered from -0.4 s and sliced.
Arrangement follows the story: sparse/tense → pulse → drive → full → bright → breakdown + resolve.
"""
import numpy as np, wave, sys

SR = 44100
BPM = 96
BEAT = 60 / BPM
BAR = 4 * BEAT
FILM = 120.6
OUT_GAIN = 0.44                 # leaves ~-20 LUFS for the final mix
OFF = 0.4                       # film t=0 is 0.4 s into scene 1
TOTAL = FILM + OFF + 3.0        # render a tail for the reverb, slice later
N = int(TOTAL * SR)
rng = np.random.default_rng(7)

def hz(m): return 440.0 * 2 ** ((m - 69) / 12)

L = np.zeros(N); R = np.zeros(N)

def add(sig, t0, gain=1.0, pan=0.0):
    i = int(t0 * SR)
    if i >= N: return
    if i < 0: sig = sig[-i:]; i = 0
    sig = sig[: N - i]
    l = np.cos((pan + 1) * np.pi / 4); r = np.sin((pan + 1) * np.pi / 4)
    L[i:i + len(sig)] += sig * gain * l
    R[i:i + len(sig)] += sig * gain * r

def env_adsr(n, a, d, s, rel):
    t = np.arange(n) / SR
    dur = n / SR
    e = np.where(t < a, t / max(a, 1e-4), np.where(t < a + d, 1 - (1 - s) * (t - a) / max(d, 1e-4), s))
    tail = np.clip((dur - t) / max(rel, 1e-4), 0, 1)
    return e * tail

def pad(midis, dur, bright=0.35):
    n = int(dur * SR); t = np.arange(n) / SR; out = np.zeros(n)
    for m in midis:
        f = hz(m)
        for det in (-0.07, 0.0, 0.06):        # slow chorus from detuned voices
            ff = f * 2 ** (det / 12)
            ph = rng.uniform(0, 2 * np.pi)
            out += np.sin(2 * np.pi * ff * t + ph)
            out += bright * 0.5 * np.sin(2 * np.pi * 2 * ff * t + ph)
            out += bright * 0.18 * np.sin(2 * np.pi * 3 * ff * t + ph)
    lfo = 0.85 + 0.15 * np.sin(2 * np.pi * 0.11 * t + rng.uniform(0, 6))
    return out * lfo * env_adsr(n, 1.4, 0.5, 0.9, 1.6) / (len(midis) * 3)

def pluck(m, dur=1.6, tone=1.0):
    n = int(dur * SR); t = np.arange(n) / SR; f = hz(m)
    e = np.exp(-t * 4.2) * np.minimum(1, t / 0.004)
    s = np.sin(2 * np.pi * f * t) + 0.35 * tone * np.sin(2 * np.pi * 2 * f * t) * np.exp(-t * 7) + 0.12 * tone * np.sin(2 * np.pi * 3.01 * f * t) * np.exp(-t * 11)
    return s * e

def bass(m, dur):
    n = int(dur * SR); t = np.arange(n) / SR; f = hz(m)
    s = np.sin(2 * np.pi * f * t) + 0.25 * np.sin(2 * np.pi * 2 * f * t)
    return s * env_adsr(n, 0.01, 0.2, 0.7, 0.12)

def kick():
    n = int(0.45 * SR); t = np.arange(n) / SR
    f = 42 + 90 * np.exp(-t * 28)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 9)

def hat(open_=False):
    n = int((0.22 if open_ else 0.06) * SR); t = np.arange(n) / SR
    x = rng.standard_normal(n); x = np.diff(np.concatenate([[0], x]))  # crude high-pass
    return x * np.exp(-t * (18 if open_ else 70))

def swell(dur=1.6):
    n = int(dur * SR); t = np.arange(n) / SR
    x = rng.standard_normal(n)
    k = 60; x = np.convolve(x, np.ones(k) / k, mode="same")  # soft, airy
    return x * (t / dur) ** 2.5 * 3.0

# Progression (2 bars each, loops): D major lydian-ish color, avoids the stock I-V-vi-IV
PROG = [
    (50, [62, 66, 69, 73, 76]),   # Dmaj9
    (47, [59, 62, 66, 69, 76]),   # Bm11
    (43, [59, 62, 66, 69, 73]),   # Gmaj7(#11) feel
    (45, [61, 64, 66, 69, 71]),   # A6/9
]
TENSE = [(47, [59, 62, 66, 69]), (43, [59, 62, 67, 71]), (45, [61, 64, 69, 72]), (42, [57, 61, 66, 69])]

def chord_at(bar, prog):
    return prog[(bar // 2) % len(prog)]

bars_total = int(TOTAL / BAR) + 1
for bar in range(bars_total):
    t0 = bar * BAR
    scene = min(5, int(t0 // 20))          # 0..5
    pos = (t0 % 20) / 20
    prog = TENSE if scene == 0 else PROG
    root, notes = chord_at(bar, prog)
    final = t0 >= 115.0 - 0.01             # last hold (film 114.6 s): resolve to Dmaj9
    first_final = final and t0 < 115.0 + BAR - 0.01

    if final:
        root, notes = PROG[0]
    # pad on every 2nd bar (2-bar chords)
    if (bar % 2 == 0 and not final) or first_final:
        dur = 2 * BAR + 1.2 if not final else 8.0
        g = [0.20, 0.22, 0.21, 0.24, 0.26, 0.22][scene]
        if scene == 5 and pos < 0.3: g = 0.14            # breakdown for the "deny" beat
        add(pad(notes, dur, bright=0.25 + 0.08 * scene), t0, g, pan=-0.15)
        add(pad([n + 12 for n in notes[1:3]], dur, bright=0.1), t0, g * 0.35, pan=0.25)

    # felt-piano arpeggio: sparse in scene 1, 8ths later, brighter in 5
    pattern = {0: [0, 3, 6], 1: [0, 2, 3, 5, 6], 2: [0, 1, 2, 3, 4, 5, 6, 7], 3: [0, 1, 2, 3, 4, 5, 6, 7],
               4: [0, 1, 2, 3, 4, 5, 6, 7], 5: [0, 2, 4, 6] if pos < 0.3 else [0, 1, 2, 3, 4, 5, 6, 7]}[scene]
    if final: pattern = [0]
    arp = notes + [n + 12 for n in notes[:2]]
    for k in pattern:
        m = arp[(bar * 3 + k * 2) % len(arp)] + (12 if scene == 4 and k % 4 == 2 else 0)
        vel = 0.10 + 0.05 * rng.random() + (0.02 if k % 2 == 0 else 0)
        add(pluck(m, 1.8, tone=0.8 + 0.1 * scene), t0 + k * BEAT / 2 + rng.normal(0, 0.004), vel, pan=rng.uniform(-0.5, 0.5))

    # bass pulse from scene 2
    if scene >= 1 and not final and not (scene == 5 and pos < 0.3):
        for b in range(4):
            add(bass(root, BEAT * 0.9), t0 + b * BEAT, [0, 0.14, 0.16, 0.20, 0.21, 0.20][scene])

    # drums: hats from scene 2, kick from scene 3, off in the breakdown
    drums = not final and not (scene == 5 and pos < 0.3)
    if scene >= 1 and drums:
        for e in range(8):
            if e % 2 == 1: add(hat(), t0 + e * BEAT / 2 + rng.normal(0, 0.003), 0.045 + 0.01 * rng.random(), pan=0.35)
        if scene >= 3: add(hat(True), t0 + 3.5 * BEAT, 0.03, pan=-0.3)
    if scene >= 2 and drums and scene != 5 or (scene == 5 and pos >= 0.55 and not final):
        for b in range(4):
            kg = 0.7 if scene == 2 else 1.0
            add(kick(), t0 + b * BEAT, kg * (0.34 if b in (0, 2) else 0.22))

# airy swells into each scene change
for k in range(1, 6):
    add(swell(1.8), 20 * k - 1.8, 0.05, pan=0.0)
add(swell(2.2), 115.0 - 2.2, 0.06)

# ---- mix bus: quarter-note "sidechain" breathing, reverb, soft clip ----
t = np.arange(N) / SR
duck = 1 - 0.18 * np.exp(-((t % BEAT) / 0.12))
L *= duck; R *= duck

def reverb(x, seconds=2.4, mix=0.28, seed=3):
    g = np.random.default_rng(seed)
    n = int(seconds * SR)
    ir = g.standard_normal(n) * np.exp(-np.arange(n) / SR * 3.2)
    ir[: int(0.02 * SR)] *= np.linspace(0, 1, int(0.02 * SR))
    k = 8; ir = np.convolve(ir, np.ones(k) / k, mode="same")  # darker tail
    ir /= np.sqrt(np.sum(ir ** 2))
    size = 1 << int(np.ceil(np.log2(len(x) + n)))
    X = np.fft.fft(x, size); fr = np.abs(np.fft.fftfreq(size, 1 / SR))
    hp = np.clip((fr - 12) / 18, 0, 1)             # DC / sub-rumble block (<30 Hz)
    y = np.real(np.fft.ifft(X * hp * (1 - mix + mix * 0.9 * np.fft.fft(ir, size))))[: len(x)]
    return y

L = reverb(L, seed=3); R = reverb(R, seed=4)
mx = np.stack([L, R], 1)
mx /= np.max(np.abs(mx)) + 1e-9
mx = np.tanh(mx * 1.3) / np.tanh(1.3)

# slice to film time, fade in/out
s0 = int(OFF * SR); mx = mx[s0: s0 + int(FILM * SR)]
n = len(mx); fi = int(1.5 * SR); fo = int(3.5 * SR)
mx[:fi] *= np.linspace(0, 1, fi)[:, None]
mx[-fo:] *= np.linspace(1, 0, fo)[:, None] ** 1.5
pcm = (mx * 0.89 * OUT_GAIN * 32767).astype(np.int16)
with wave.open(sys.argv[1], "wb") as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())
print("wrote", sys.argv[1], f"{n / SR:.1f}s")
