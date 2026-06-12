"""Platform adapters: map external commerce platforms onto Warp commerce types.

Each adapter (``stripe``, ``shopify``) transforms a platform payload into the
typed Warp model and synthesizes a valid transition history so the result passes
the package's own ``audit_commerce`` auditor.
"""
