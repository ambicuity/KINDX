export type ArchConfidence = "EXTRACTED" | "INFERRED" | "AMBIGUOUS";

export type ArchNode = {
  id: string;
  label?: string;
  file_type?: string;
  source_file?: string;
  source_location?: string;
  community?: number | null;
};

export type ArchLink = {
  source: string;
  target: string;
  relation?: string;
  confidence?: ArchConfidence | string;
  confidence_score?: number;
  source_file?: string;
  source_location?: string;
};

export type ArchHyperedge = {
  id?: string;
  label?: string;
  nodes?: string[];
  confidence?: ArchConfidence | string;
  confidence_score?: number;
  source_file?: string;
};

export type ArchGraphJson = {
  nodes: ArchNode[];
  links: ArchLink[];
  hyperedges?: ArchHyperedge[];
};

export type DistilledArchArtifact = {
  sourceRoot: string;
  graphJsonPath: string;
  reportPath?: string;
  generatedAt: string;
  nodeCount: number;
  edgeCount: number;
  communityCount: number;
  files: string[];
  hintsPath: string;
  confidenceBreakdown: {
    EXTRACTED: number;
    INFERRED: number;
    AMBIGUOUS: number;
  };
};

export type ArchHint = {
  id: string;
  kind: "community" | "god_node" | "surprising_edge" | "report";
  title: string;
  body: string;
  scoreSignals: string[];
  confidence?: ArchConfidence;
  sourceFiles: string[];
};
