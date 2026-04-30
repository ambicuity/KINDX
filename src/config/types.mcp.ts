export type McpServerConfig = {
  enabled_tools?: string[];
  disabled_tools?: string[];
  startup_timeout_sec?: number;
  tool_timeout_sec?: number;
  http_headers?: Record<string, string>;
  env_http_headers?: Record<string, string>;
  bearer_token_env_var?: string;
  project_scoped?: boolean;
};

export type McpServersConfig = Record<string, McpServerConfig>;
