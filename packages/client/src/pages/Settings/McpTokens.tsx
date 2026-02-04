import { useState } from "react";
import { Badge, Button, Card, EmptyState, Input, Label } from "../../components/ui";
import { trpc } from "../../trpc";

export default function McpTokens() {
  const [newTokenName, setNewTokenName] = useState("");
  const [createdToken, setCreatedToken] = useState<{
    rawToken: string;
    mcpUrl: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);

  const { data: tokens, isLoading } = trpc.mcp.listTokens.useQuery();
  const utils = trpc.useUtils();

  const createMutation = trpc.mcp.createToken.useMutation({
    onSuccess: (data) => {
      setCreatedToken({ rawToken: data.rawToken, mcpUrl: data.mcpUrl });
      setNewTokenName("");
      utils.mcp.listTokens.invalidate();
    },
  });

  const deleteMutation = trpc.mcp.deleteToken.useMutation({
    onSuccess: () => {
      utils.mcp.listTokens.invalidate();
    },
  });

  const handleCreate = () => {
    createMutation.mutate({ name: newTokenName || undefined });
  };

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDelete = (id: string) => {
    if (!confirm("Revoke this MCP token? Any clients using it will lose access.")) {
      return;
    }
    deleteMutation.mutate({ id });
  };

  const formatDate = (date: Date | string | null) => {
    if (!date) return "Never";
    return new Date(date).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-medium text-white">MCP Access</h2>
        <p className="text-sm text-white/40 mt-1">
          Generate tokens to connect AI assistants (like Claude) to Annex via the Model Context
          Protocol. Each token provides a unique URL for MCP client configuration.
        </p>
      </div>

      {/* Token creation */}
      <Card className="p-4 space-y-4">
        <div>
          <Label>Token Name (optional)</Label>
          <div className="flex gap-2 mt-1">
            <Input
              value={newTokenName}
              onChange={(e) => setNewTokenName(e.target.value)}
              placeholder="e.g. Claude Desktop, Work laptop"
              className="flex-1"
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreate();
              }}
            />
            <Button onClick={handleCreate} disabled={createMutation.isLoading} popcorn={false}>
              {createMutation.isLoading ? "Creating..." : "Generate Token"}
            </Button>
          </div>
        </div>

        {/* Show newly created token */}
        {createdToken && (
          <div className="bg-annex-500/10 border border-annex-500/30 rounded p-4 space-y-3">
            <p className="text-sm text-annex-400 font-medium">
              Token created -- copy the URL below. It will not be shown again.
            </p>
            <div>
              <Label className="text-white/50 text-xs">MCP URL</Label>
              <div className="flex gap-2 mt-1">
                <Input value={createdToken.mcpUrl} readOnly className="flex-1 font-mono text-xs" />
                <Button
                  variant="secondary"
                  onClick={() => handleCopy(createdToken.mcpUrl)}
                  popcorn={false}
                >
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setCreatedToken(null)} popcorn={false}>
              Dismiss
            </Button>
          </div>
        )}
      </Card>

      {/* Existing tokens */}
      {isLoading ? (
        <div className="text-white/40 text-sm">Loading tokens...</div>
      ) : !tokens || tokens.length === 0 ? (
        <EmptyState
          title="No MCP tokens"
          description="Generate a token to connect an AI assistant to Annex."
        />
      ) : (
        <div className="space-y-2">
          {tokens.map(
            (token: {
              id: string;
              name: string | null;
              lastUsedAt: Date | null;
              createdAt: Date;
            }) => (
              <Card key={token.id} className="p-4 flex items-center justify-between">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-white font-medium truncate">
                        {token.name || "Unnamed token"}
                      </span>
                      {token.lastUsedAt && <Badge variant="success">Active</Badge>}
                    </div>
                    <div className="flex gap-3 text-xs text-white/30 mt-0.5">
                      <span>Created {formatDate(token.createdAt)}</span>
                      <span>Last used {formatDate(token.lastUsedAt)}</span>
                    </div>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleDelete(token.id)}
                  disabled={deleteMutation.isLoading}
                  popcorn={false}
                  className="text-white/40 hover:text-annex-400"
                >
                  Revoke
                </Button>
              </Card>
            )
          )}
        </div>
      )}
    </div>
  );
}
