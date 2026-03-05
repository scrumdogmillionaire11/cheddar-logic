/**
 * FPL Dual-Engine Integration Tests
 * 
 * Validates contract between Worker JS and Sage Python
 */

const { getSagePrediction, validatePredictionSchema } = require('../fpl-types.js');

describe('FPL Worker-Sage Contract', () => {
  it('should validate prediction schema from Sage', () => {
    const mockPrediction = {
      player_id: 1,
      predicted_points: 7.5,
      confidence: 0.82,
      model_version: '1.0.0',
      timestamp: new Date().toISOString(),
    };
    
    expect(validatePredictionSchema(mockPrediction)).toBe(true);
  });

  it('should reject invalid predictions (missing fields)', () => {
    const invalidPrediction = {
      player_id: 1,
      predicted_points: 7.5,
      // Missing confidence, model_version, timestamp
    };
    
    expect(validatePredictionSchema(invalidPrediction)).toBe(false);
  });

  it('should reject invalid predictions (wrong types)', () => {
    const invalidPrediction = {
      player_id: '1', // Should be number
      predicted_points: 7.5,
      confidence: 0.82,
      model_version: '1.0.0',
      timestamp: new Date().toISOString(),
    };
    
    expect(validatePredictionSchema(invalidPrediction)).toBe(false);
  });
});