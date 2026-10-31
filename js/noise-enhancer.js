/*
 * NoiseEnhancer AudioWorklet 处理器
 * 用途：回放噪声样本时，适度压低稳态背景噪声、轻微突出瞬态撞击声
 * 设计原则：保守处理，宁可保留背景也不切断声音（避免断续/咔哒/变闷）
 * 算法：
 *   1. 自适应噪声底估计：慢速跟踪背景稳态噪声
 *   2. 噪声门：低于门限时衰减到 floorGain（非完全静音），保留自然感
 *   3. 瞬态增强：撞击声轻微增益（不超过 1.5 倍，避免失真）
 *   4. 软削波：防止数字削波失真
 */
class NoiseEnhancerProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'gateMargin', defaultValue: 6, minValue: 0, maxValue: 24,
        automationRate: 'k-rate' },
      { name: 'transientBoost', defaultValue: 1.5, minValue: 1, maxValue: 4,
        automationRate: 'k-rate' },
      { name: 'gateFloor', defaultValue: 0.005, minValue: 0, maxValue: 0.1,
        automationRate: 'k-rate' },
      { name: 'floorGain', defaultValue: 0.2, minValue: 0, maxValue: 0.6,
        automationRate: 'k-rate' }
    ];
  }

  constructor() {
    super();
    this.noiseFloor = 0.001;       // 自适应噪声底
    this.gateGain = 1;              // 当前门增益（初始=1，避免开头被切掉）
    this.smoothedEnv = 0;           // 平滑包络，用于瞬态检测
    // 系数（按采样率换算，sampleRate 为 AudioWorklet 全局）
    this.attackCoeff = Math.exp(-1 / (sampleRate * 0.003));    // 3ms 开门
    this.releaseCoeff = Math.exp(-1 / (sampleRate * 0.12));    // 120ms 关门（更慢，避免抽吸）
    // 噪声底自适应
    this.noiseDecayCoeff = Math.exp(-1 / (sampleRate * 0.5));  // 0.5s 衰减
    this.noiseRiseCoeff = Math.exp(-1 / (sampleRate * 10.0));  // 10s 上升
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input.length) return true;

    const gateMarginDb = parameters.gateMargin[0];
    const transientBoost = parameters.transientBoost[0];
    const gateFloor = parameters.gateFloor[0];
    const floorGain = parameters.floorGain[0];
    const gateMarginLin = Math.pow(10, gateMarginDb / 20);

    for (let ch = 0; ch < input.length; ch++) {
      const inCh = input[ch];
      const outCh = output[ch];
      if (!inCh || !outCh) continue;

      for (let i = 0; i < inCh.length; i++) {
        const sample = inCh[i];
        const absSample = Math.abs(sample);

        // —— 1. 自适应噪声底估计 ——
        if (absSample < this.noiseFloor) {
          this.noiseFloor = this.noiseFloor * this.noiseDecayCoeff
            + absSample * (1 - this.noiseDecayCoeff);
        } else {
          this.noiseFloor = this.noiseFloor * this.noiseRiseCoeff
            + absSample * (1 - this.noiseRiseCoeff);
        }

        // —— 2. 动态门限 ——
        const threshold = Math.max(this.noiseFloor * gateMarginLin, gateFloor);

        // —— 3. 噪声门决策：低于门限衰减到 floorGain，非完全静音 ——
        const targetGain = absSample > threshold ? 1.0 : floorGain;
        if (targetGain > this.gateGain) {
          this.gateGain = this.gateGain * this.attackCoeff
            + targetGain * (1 - this.attackCoeff);
        } else {
          this.gateGain = this.gateGain * this.releaseCoeff
            + targetGain * (1 - this.releaseCoeff);
        }

        // —— 4. 瞬态检测：轻微增强撞击声 ——
        this.smoothedEnv = this.smoothedEnv * 0.95 + absSample * 0.05;
        const transientRatio = absSample / (this.smoothedEnv + 1e-7);
        let boost = 1.0;
        if (transientRatio > 2.5 && absSample > threshold) {
          boost = transientBoost;
        }

        // —— 5. 应用门控 + 瞬态增强 ——
        let outSample = sample * this.gateGain * boost;

        // —— 6. 软削波 ——
        if (outSample > 0.95) {
          outSample = 0.95 + (outSample - 0.95) * 0.1;
        } else if (outSample < -0.95) {
          outSample = -0.95 + (outSample + 0.95) * 0.1;
        }

        outCh[i] = outSample;
      }
    }
    return true;
  }
}

registerProcessor('noise-enhancer', NoiseEnhancerProcessor);
