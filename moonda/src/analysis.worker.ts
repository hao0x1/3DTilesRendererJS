import { analyzeScenario } from './scenarios';
import type { PreparedScenario, ScenarioAnalysis, ScenarioDefinition } from './scenarios';
import type { EnergyModel } from './energy';

export interface AnalysisRequest {
  key: string;
  prepared: PreparedScenario;
  scenario: ScenarioDefinition;
  energyModel: EnergyModel;
}
export type AnalysisResponse = { key: string; result: ScenarioAnalysis } | { key: string; error: string };

self.onmessage = (event: MessageEvent<AnalysisRequest>) => {
  const { key, prepared, scenario, energyModel } = event.data;
  try {
    const result = analyzeScenario(prepared, scenario, energyModel);
    self.postMessage({ key, result } satisfies AnalysisResponse);
  } catch (error) {
    self.postMessage({ key, error: error instanceof Error ? error.message : 'Energy analysis failed.' } satisfies AnalysisResponse);
  }
};
