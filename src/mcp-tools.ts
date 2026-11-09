export const MCP_TOOLS = [
  {
    name: "get_capabilities",
    title: "Get PSB cleaner capabilities",
    description:
      "Read supported formats, safety limits, profiles, adapted Photoshop versions, and the experimental version policy.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: "list_profiles",
    title: "List cleanup profiles",
    description:
      "Read standard, deep, and conservative DocumentAncestors cleanup thresholds.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: "submit_jobs",
    title: "Submit explicit PSB jobs",
    description:
      "Submit only explicitly named files. safe_copy is the default. in_place is destructive, may run unattended, skips post-save validation, and must explicitly declare whether a recovery backup is required.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["jobs"],
      properties: {
        jobs: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["sourcePath"],
            properties: {
              sourcePath: { type: "string" },
              profile: {
                type: "string",
                enum: ["standard", "deep", "conservative"],
                default: "standard",
              },
              runMode: {
                type: "string",
                enum: [
                  "inspect_only",
                  "auto_if_eligible",
                  "await_approval",
                ],
                default: "auto_if_eligible",
              },
              executionMode: {
                type: "string",
                enum: ["safe_copy", "in_place"],
                default: "safe_copy",
                description:
                  "safe_copy publishes a separately validated copy. in_place overwrites the source and skips post-save validation.",
              },
              backupSource: {
                type: "boolean",
                default: true,
                description:
                  "For in_place jobs, create and SHA-256 verify a recovery backup before Photoshop opens the source.",
              },
              requiredValidationChecks: {
                type: "array",
                uniqueItems: true,
                description:
                  "Checks that must pass for automatic publication. Omitted means strict defaults; unchecked checks are still reported.",
                items: {
                  type: "string",
                  enum: [
                    "target_xmp_removed",
                    "structure_topology",
                    "smart_object_asset_ids",
                    "smart_object_success",
                    "reopen_success",
                    "pixel_exact",
                    "render_consistency",
                    "parser_clean",
                  ],
                },
              },
              outputMode: {
                type: "string",
                enum: ["specified_directory", "source_subfolder"],
                default: "specified_directory",
              },
              outputDir: { type: "string" },
              clientRequestId: {
                type: "string",
                description:
                  "Caller-stable idempotency key. Repeating it returns the original job.",
              },
            },
          },
        },
      },
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    },
  },
  {
    name: "preflight",
    title: "Preflight one PSB",
    description:
      "Create a read-only inspection job without starting Photoshop.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["sourcePath"],
      properties: {
        sourcePath: { type: "string" },
        profile: {
          type: "string",
          enum: ["standard", "deep", "conservative"],
          default: "standard",
        },
        requiredValidationChecks: {
          type: "array",
          uniqueItems: true,
          items: {
            type: "string",
            enum: [
              "target_xmp_removed",
              "structure_topology",
              "smart_object_asset_ids",
              "smart_object_success",
              "reopen_success",
              "pixel_exact",
              "render_consistency",
              "parser_clean",
            ],
          },
        },
        clientRequestId: { type: "string" },
      },
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "get_job",
    title: "Get one job",
    description: "Read current state and artifact paths for one job.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["jobId"],
      properties: { jobId: { type: "string" } },
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: "list_jobs",
    title: "List jobs",
    description: "List recent jobs, optionally filtered by status.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 500 },
        status: { type: "string" },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: "cancel_job",
    title: "Safely cancel one job",
    description:
      "Request cooperative cancellation. Photoshop is never force-terminated.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["jobId"],
      properties: { jobId: { type: "string" } },
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "get_report",
    title: "Get a per-file report",
    description: "Read the canonical JSON report for one file job.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["jobId"],
      properties: { jobId: { type: "string" } },
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: "get_queue_status",
    title: "Get queue status",
    description: "Read queue pause, critical reason, and runnable count.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: "pause_queue",
    title: "Pause the queue",
    description:
      "Pause new work. An active Photoshop save is allowed to reach a safe checkpoint.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "resume_queue",
    title: "Resume the queue",
    description:
      "Resume a normal user pause. Critical safety pauses require desktop acknowledgement.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "stop_queue_after_current",
    title: "Stop waiting jobs after the current file",
    description:
      "Let the actively processing file reach a safe terminal state, pause the queue, and cancel jobs that have not started. Cancelled waiting jobs are not resumed automatically.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    },
  },
] as const;
