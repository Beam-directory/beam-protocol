import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const registerAgent = mutation({
  args: {
    beamId: v.string(),
    orgId: v.string(),
    displayName: v.string(),
    capabilities: v.array(v.string()),
    publicKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("agents")
      .withIndex("by_beamId", (q) => q.eq("beamId", args.beamId))
      .first();

    if (existing) {
      // Update last seen + capabilities
      await ctx.db.patch(existing._id, {
        capabilities: args.capabilities,
        publicKey: args.publicKey ?? existing.publicKey,
        lastSeen: Date.now(),
      });
      return existing._id;
    }

    return await ctx.db.insert("agents", {
      beamId: args.beamId,
      orgId: args.orgId,
      displayName: args.displayName,
      capabilities: args.capabilities,
      publicKey: args.publicKey,
      trustScore: 0,
      verified: false,
      lastSeen: Date.now(),
      createdAt: Date.now(),
    });
  },
});

export const getAgentByBeamId = query({
  args: { beamId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("agents")
      .withIndex("by_beamId", (q) => q.eq("beamId", args.beamId))
      .first();
  },
});

export const getOrgAgents = query({
  args: { orgId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("agents")
      .withIndex("by_orgId", (q) => q.eq("orgId", args.orgId))
      .collect();
  },
});

export const listAllAgents = query({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("agents")
      .order("desc")
      .take(args.limit ?? 50);
  },
});

export const updateTrustScore = mutation({
  args: {
    beamId: v.string(),
    trustScore: v.number(),
  },
  handler: async (ctx, args) => {
    const agent = await ctx.db
      .query("agents")
      .withIndex("by_beamId", (q) => q.eq("beamId", args.beamId))
      .first();

    if (!agent) throw new Error("Agent not found");

    await ctx.db.patch(agent._id, {
      trustScore: Math.max(0, Math.min(100, args.trustScore)),
    });
  },
});
