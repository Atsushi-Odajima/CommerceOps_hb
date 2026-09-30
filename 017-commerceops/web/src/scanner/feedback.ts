/** scan の音・振動フィードバック（外部アセット不要。iOS は vibrate 非対応のため音のみ） */
let ctx: AudioContext | null = null;

function tone(freq: number, ms: number, when = 0, type: OscillatorType = 'sine') {
  try {
    ctx ??= new (window.AudioContext || (window as any).webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.value = 0.15;
    osc.connect(gain).connect(ctx.destination);
    const t = ctx.currentTime + when;
    osc.start(t);
    osc.stop(t + ms / 1000);
  } catch {
    /* 音が出せない環境では無視 */
  }
}

export function feedbackOk() {
  tone(1046, 70);
  navigator.vibrate?.(40);
}

export function feedbackError() {
  tone(220, 180, 0, 'square');
  tone(180, 220, 0.22, 'square');
  navigator.vibrate?.([180, 80, 180]);
}

export function feedbackDone() {
  tone(784, 90);
  tone(1046, 90, 0.1);
  tone(1318, 140, 0.2);
  navigator.vibrate?.([60, 40, 60]);
}

/** ユーザー操作時に AudioContext を初期化（iOS Safari の自動再生制限対策） */
export function unlockAudio() {
  try {
    ctx ??= new (window.AudioContext || (window as any).webkitAudioContext)();
    if (ctx.state === 'suspended') void ctx.resume();
  } catch {
    /* noop */
  }
}
