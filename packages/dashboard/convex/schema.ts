import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  organizations: defineTable({
    orgId: v.string(),
    name: v.string(),
    verified: v.boolean(),
    verifiedAt: v.optional(v.number()),
    domain: v.optional(v.string()),
    plan: v.union(v.literal("free"), v.literal("pro"), v.literal("enterprise")),
    stripeCustomerId: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_orgId", ["orgId"])
    .index("by_domain", ["domain"]),

  agents: defineTable({
    beamId: v.string(),
    orgId: v.string(),
    displayName: v.string(),
    capabilities: v.array(v.string()),
    publicKey: v.optional(v.string()),
    trustScore: v.number(),
    verified: v.boolean(),
    lastSeen: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_orgId", ["orgId"])
    .index("by_beamId", ["beamId"])
    .index("by_trustScore", ["trustScore"]),

  intents: defineTable({
    fromBeamId: v.string(),
    toBeamId: v.string(),
    intent: v.string(),
    nonce: v.string(),
    timestamp: v.number(),
    latencyMs: v.optional(v.number()),
    success: v.boolean(),
    errorCode: v.optional(v.string()),
  })
    .index("by_fromBeamId", ["fromBeamId"])
    .index("by_toBeamId", ["toBeamId"])
    .index("by_timestamp", ["timestamp"])
    .index("by_nonce", ["nonce"]),

  apiKeys: defineTable({
    orgId: v.string(),
    keyHash: v.string(),
    name: v.string(),
    createdAt: v.number(),
    lastUsedAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
  })
    .index("by_orgId", ["orgId"])
    .index("by_keyHash", ["keyHash"]),

  waitlist: defineTable({
    email: v.string(),
    createdAt: v.number(),
    source: v.optional(v.string()),
  })
    .index("by_email", ["email"])
    .index("by_createdAt", ["createdAt"]),
});
