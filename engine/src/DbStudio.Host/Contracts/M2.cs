using System.Text.Json;
using DbStudio.Core.Models;

namespace DbStudio.Host.Contracts;

// M2 request/response DTOs of the framework endpoints (docs/PLAN-M2.md 1.1; mirrors ui/src/api/types.ts "M2" section).
// Feature packages keep their own DTOs next to their endpoints in their projects.

/// <summary>POST /streams body.</summary>
public sealed record StreamOpenRequest(string? Kind, string? ConnectionId, JsonElement? Params);

/// <summary>202 response of POST /streams.</summary>
public sealed record StreamOpenResponse(string StreamId);

