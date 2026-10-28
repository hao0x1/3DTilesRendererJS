export interface Horizon {
  azimuthStepDeg: number;
  elevationDeg: number[];
  maxRangeKm: number;
  terrainResolutionM: number;
  method: string;
}

export interface Terrain {
  size: number;
  bounds: { eastMinM: number; eastMaxM: number; northMinM: number; northMaxM: number };
  heightsM: number[];
  referenceRadiusM: number;
  tilesetUrl?: string;
  centerHeightM?: number;
}

export interface Ephemeris {
  timesUtc: string[];
  sunAzDeg: number[];
  sunElDeg: number[];
  earthAzDeg: number[];
  earthElDeg: number[];
}

export interface Site {
  id: string;
  name: string;
  latitudeDeg: number;
  longitudeDeg: number;
  observerHeightM: number;
  description: string;
  horizon: Horizon;
  terrain: Terrain;
  ephemeris: Ephemeris;
  provenance: { title: string; url: string; detail?: string }[];
  limitations: string[];
}

export interface ObservatoryData {
  generatedAt: string;
  version: string;
  description: string;
  sites: Site[];
  limitations: string[];
}

export interface Mission {
  startIndex: number;
  durationHours: number;
  maxDarkHours: number;
  maxEarthGapHours: number;
  terrainEnabled: boolean;
}

export interface SkySample {
  timeUtc: string;
  sunAz: number;
  sunEl: number;
  earthAz: number;
  earthEl: number;
  sunHorizon: number;
  earthHorizon: number;
  sunVisible: boolean;
  earthVisible: boolean;
}

export interface SiteAnalysis {
  siteId: string;
  solarPercent: number;
  earthPercent: number;
  overlapPercent: number;
  longestDarkHours: number;
  longestEarthGapHours: number;
  actualDurationHours: number;
  fits: boolean;
  samples: SkySample[];
}
