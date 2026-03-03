const DEFAULT_CONFIG = {
  l5Weight: 0.65,
  priorWeight: 0.35,
  homeIceSogBoost: 1.05,
  homeIce1PBoost: 1.03,
  highVolumeRegression: 0.9,
  highVolumeThreshold: 4.5,
  periodShare1P: 0.32,
  trending: {
    minHits: 4,
    meanBuffer: 1.0
  },
  quality: {
    sampleGamesMax: 5,
    varianceCvLow: 0.2,
    varianceCvHigh: 0.6,
    varianceCvSweetLow: 0.2,
    varianceCvSweetHigh: 0.4,
    roleWeights: {
      bottom6: 1.0,
      top6: 0.85,
      topLine: 0.7,
      pp1: 0.65,
      elite: 0.6
    },
    bufferLow: 0.2,
    bufferHigh: 0.6
  },
  classification: {
    hotMaxQuality: 0.6,
    watchMaxQuality: 0.72,
    watchMinMu: 3.5
  }
};

module.exports = {
  DEFAULT_CONFIG
};
