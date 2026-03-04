import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const createOrg = mutation({
  args: {
    orgId: v.string(),
    name: v.string(),
    domain: v.optional(v.string()),
    plan: v.optional(v.union(v.literal("free"), v.literal("pro"), v.literal("enterprise"))),
  },
  handler: async (ctx, args) => {
    // Check for duplicate orgId
    const existing = await ctx.db
      .query("organizations")
      .withIndex("by_orgId", (q) => q.eq("orgId", args.orgId))
      .first();

    if (existing) {
      throw new Error(`Organization with orgId '${args.orgId}' already exists`);
    }

    return await ctx.db.insert("organizations", {
      orgId: args.orgId,
      name: args.name,
      verified: false,
      domain: args.domain,
      plan: args.plan ?? "free",
      createdAt: Date.now(),
    });
  },
});

export const getOrg = query({
  args: { orgId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("organizations")
      .withIndex("by_orgId", (q) => q.eq("orgId", args.orgId))
      .first();
  },
});

export const verifyOrg = mutation({
  args: { orgId: v.string() },
  handler: async (ctx, args) => {
    const org = await ctx.db
      .query("organizations")
      .withIndex("by_orgId", (q) => q.eq("orgId", args.orgId))
      .first();

    if (!org) throw new Error("Organization not found");

    await ctx.db.patch(org._id, {
      verified: true,
      verifiedAt: Date.now(),
    });
  },
});

export const listOrgs = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("organizations").order("desc").take(100);
  },
});
