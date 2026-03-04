import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const logIntent = mutation({
  args: {
    fromBeamId: v.string(),
    toBeamId: v.string(),
    intent: v.string(),
    nonce: v.string(),
    latencyMs: v.optional(v.number()),
    success: v.boolean(),
    errorCode: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("intents", {
      fromBeamId: args.fromBeamId,
      toBeamId: args.toBeamId,
      intent: args.intent,
      nonce: args.nonce,
      timestamp: Date.now(),
      latencyMs: args.latencyMs,
      success: args.success,
      errorCode: args.errorCode,
    });
  },
});

export const getIntentLog = query({
  args: {
    limit: v.optional(v.number()),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 50;

    const results = await ctx.db
      .query("intents")
      .withIndex("by_timestamp")
      .order("desc")
      .take(limit + 1);

    const hasMore = results.length > limit;
    const items = hasMore ? results.slice(0, limit) : results;

    return {
      items,
      hasMore,
    };
  },
});

export const getIntentsByAgent = query({
  args: { beamId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 30;
    const sent = await ctx.db
      .query("intents")
      .withIndex("by_fromBeamId", (q) => q.eq("fromBeamId", args.beamId))
      .order("desc")
      .take(limit);

    return sent;
  },
});

export const getOrgStats = query({
  args: { orgId: v.string() },
  handler: async (ctx, args) => {
    // Get all agents for org
    const agents = await ctx.db
      .query("agents")
      .withIndex("by_orgId", (q) => q.eq("orgId", args.orgId))
      .collect();

    const agentBeamIds = new Set(agents.map((a) => a.beamId));
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;

    // All intents in last 30 days involving org's agents
    const allIntents = await ctx.db
      .query("intents")
      .withIndex("by_timestamp")
      .order("desc")
      .take(10000);

    const orgIntents = allIntents.filter(
      (i) =>
        (agentBeamIds.has(i.fromBeamId) || agentBeamIds.has(i.toBeamId)) &&
        i.timestamp >= now - 30 * day
    );

    const intents24h = orgIntents.filter((i) => i.timestamp >= now - day);
    const intents7d = orgIntents.filter((i) => i.timestamp >= now - 7 * day);
    const intents30d = orgIntents;

    const avgLatency =
      orgIntents.length > 0
        ? Math.round(
            orgIntents
              .filter((i) => i.latencyMs !== undefined)
              .reduce((sum, i) => sum + (i.latencyMs ?? 0), 0) /
              orgIntents.filter((i) => i.latencyMs !== undefined).length
          )
        : 0;

    const successRate =
      orgIntents.length > 0
        ? Math.round(
            (orgIntents.filter((i) => i.success).length / orgIntents.length) *
              100
          )
        : 0;

    return {
      agentCount: agents.length,
      intents24h: intents24h.length,
      intents7d: intents7d.length,
      intents30d: intents30d.length,
      avgLatencyMs: avgLatency,
      successRate,
    };
  },
});

export const getGlobalStats = query({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;

    const agentCount = (await ctx.db.query("agents").collect()).length;
    const orgCount = (await ctx.db.query("organizations").collect()).length;

    const recentIntents = await ctx.db
      .query("intents")
      .withIndex("by_timestamp")
      .order("desc")
      .take(10000);

    const intents24h = recentIntents.filter((i) => i.timestamp >= now - day);
    const intents7d = recentIntents.filter((i) => i.timestamp >= now - 7 * day);
    const intents30d = recentIntents.filter(
      (i) => i.timestamp >= now - 30 * day
    );

    // Trust score distribution
    const agents = await ctx.db.query("agents").collect();
    const trustBuckets = { low: 0, medium: 0, high: 0, elite: 0 };
    for (const a of agents) {
      if (a.trustScore < 25) trustBuckets.low++;
      else if (a.trustScore < 50) trustBuckets.medium++;
      else if (a.trustScore < 75) trustBuckets.high++;
      else trustBuckets.elite++;
    }

    const avgLatency =
      recentIntents.length > 0
        ? Math.round(
            recentIntents
              .filter((i) => i.latencyMs !== undefined)
              .reduce((sum, i) => sum + (i.latencyMs ?? 0), 0) /
              Math.max(1, recentIntents.filter((i) => i.latencyMs !== undefined).length)
          )
        : 0;

    return {
      agentCount,
      orgCount,
      intents24h: intents24h.length,
      intents7d: intents7d.length,
      intents30d: intents30d.length,
      avgLatencyMs: avgLatency,
      trustDistribution: trustBuckets,
    };
  },
});
