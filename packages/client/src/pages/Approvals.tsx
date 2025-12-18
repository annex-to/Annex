import { useState } from "react";
import { trpc } from "../trpc";
import { Button, Card, Badge, EmptyState } from "../components/ui";

export default function Approvals() {
  const [filter, setFilter] = useState<"PENDING" | "ALL">("PENDING");
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [comment, setComment] = useState("");

  const { data: approvals, isLoading } = trpc.approvals.list.useQuery(
    filter === "PENDING" ? { status: "PENDING" } : undefined
  );
  const { data: pendingCount } = trpc.approvals.pendingCount.useQuery();
  const utils = trpc.useUtils();

  const processMutation = trpc.approvals.process.useMutation({
    onSuccess: () => {
      utils.approvals.list.invalidate();
      utils.approvals.pendingCount.invalidate();
      setProcessingId(null);
      setComment("");
    },
  });

  const handleProcess = async (id: string, action: "approve" | "reject") => {
    try {
      await processMutation.mutateAsync({
        id,
        action,
        processedBy: "user",
        comment: comment || undefined,
      });
    } catch (error) {
      alert(`Failed to ${action}: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "PENDING":
        return <Badge className="bg-gold-500/20 text-gold-400 border-gold-500/30">Pending</Badge>;
      case "APPROVED":
        return <Badge className="bg-green-500/20 text-green-400 border-green-500/30">Approved</Badge>;
      case "REJECTED":
        return <Badge className="bg-red-500/20 text-red-400 border-red-500/30">Rejected</Badge>;
      case "TIMEOUT":
        return <Badge className="bg-orange-500/20 text-orange-400 border-orange-500/30">Timed Out</Badge>;
      default:
        return <Badge className="bg-white/20 text-white/70 border-white/30">{status}</Badge>;
    }
  };

  const formatDate = (date: Date) => {
    return new Date(date).toLocaleString();
  };

  const getTimeRemaining = (createdAt: Date, timeoutHours: number | null) => {
    if (!timeoutHours) return null;
    const created = new Date(createdAt).getTime();
    const timeout = created + timeoutHours * 60 * 60 * 1000;
    const remaining = timeout - Date.now();
    if (remaining <= 0) return "Expired";
    const hours = Math.floor(remaining / (60 * 60 * 1000));
    const minutes = Math.floor((remaining % (60 * 60 * 1000)) / (60 * 1000));
    return `${hours}h ${minutes}m`;
  };

  if (isLoading) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-white mb-6">Approvals</h1>
        <div className="text-white/60">Loading...</div>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-4">
          <h1 className="text-2xl font-bold text-white">Approvals</h1>
          {pendingCount && pendingCount.count > 0 && (
            <Badge className="bg-annex-500/20 text-annex-400 border-annex-500/30">
              {pendingCount.count} pending
            </Badge>
          )}
        </div>

        <div className="flex gap-2">
          <Button
            variant={filter === "PENDING" ? "primary" : "secondary"}
            size="sm"
            onClick={() => setFilter("PENDING")}
          >
            Pending
          </Button>
          <Button
            variant={filter === "ALL" ? "primary" : "secondary"}
            size="sm"
            onClick={() => setFilter("ALL")}
          >
            All
          </Button>
        </div>
      </div>

      <div className="space-y-4">
        {approvals && approvals.length > 0 ? (
          approvals.map((approval) => (
            <Card key={approval.id} className="p-4">
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-3 mb-3">
                    <h3 className="text-lg font-semibold text-white">
                      {approval.request.title} ({approval.request.year})
                    </h3>
                    {getStatusBadge(approval.status)}
                    <Badge className="bg-white/10 text-white/70 border-white/20">
                      {approval.request.type}
                    </Badge>
                  </div>

                  <div className="space-y-2 text-sm">
                    {approval.reason && (
                      <div className="text-white/80">
                        <span className="font-medium">Reason:</span> {approval.reason}
                      </div>
                    )}
                    <div className="text-white/60">
                      <span className="font-medium">Required Role:</span> {approval.requiredRole}
                    </div>
                    <div className="text-white/60">
                      <span className="font-medium">Created:</span> {formatDate(approval.createdAt)}
                    </div>
                    {approval.timeoutHours && approval.status === "PENDING" && (
                      <div className="text-white/60">
                        <span className="font-medium">Time Remaining:</span>{" "}
                        {getTimeRemaining(approval.createdAt, approval.timeoutHours)}
                        {approval.autoAction && (
                          <span className="ml-2 text-gold-400">
                            (will auto-{approval.autoAction})
                          </span>
                        )}
                      </div>
                    )}
                    {approval.processedBy && (
                      <div className="text-white/60">
                        <span className="font-medium">Processed by:</span> {approval.processedBy}
                        {approval.processedAt && ` on ${formatDate(approval.processedAt)}`}
                      </div>
                    )}
                    {approval.comment && (
                      <div className="text-white/80 italic">
                        <span className="font-medium">Comment:</span> {approval.comment}
                      </div>
                    )}
                  </div>

                  {processingId === approval.id && (
                    <div className="mt-3 space-y-2">
                      <textarea
                        value={comment}
                        onChange={(e) => setComment(e.target.value)}
                        placeholder="Add comment (optional)"
                        className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-white placeholder-white/25 resize-none"
                        rows={2}
                      />
                    </div>
                  )}
                </div>

                <div className="flex gap-2">
                  {approval.status === "PENDING" && (
                    <>
                      {processingId === approval.id ? (
                        <>
                          <Button
                            size="sm"
                            onClick={() => handleProcess(approval.id, "approve")}
                            disabled={processMutation.isPending}
                            className="bg-green-500/20 text-green-400 border-green-500/30 hover:bg-green-500/30"
                          >
                            Confirm Approve
                          </Button>
                          <Button
                            size="sm"
                            onClick={() => handleProcess(approval.id, "reject")}
                            disabled={processMutation.isPending}
                            className="bg-red-500/20 text-red-400 border-red-500/30 hover:bg-red-500/30"
                          >
                            Confirm Reject
                          </Button>
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => {
                              setProcessingId(null);
                              setComment("");
                            }}
                          >
                            Cancel
                          </Button>
                        </>
                      ) : (
                        <Button
                          variant="primary"
                          size="sm"
                          onClick={() => setProcessingId(approval.id)}
                        >
                          Process
                        </Button>
                      )}
                    </>
                  )}
                </div>
              </div>
            </Card>
          ))
        ) : (
          <EmptyState
            icon="✓"
            title={filter === "PENDING" ? "No pending approvals" : "No approvals"}
            description={
              filter === "PENDING"
                ? "All approvals have been processed"
                : "No approval requests have been created yet"
            }
          />
        )}
      </div>
    </div>
  );
}
