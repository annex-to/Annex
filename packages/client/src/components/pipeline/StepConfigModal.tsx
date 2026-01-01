import { useEffect, useState } from "react";
import { Button, Card, Input, Label, Select } from "../ui";

interface StepNodeData {
  label: string;
  type: "START" | "SEARCH" | "DOWNLOAD" | "ENCODE" | "DELIVER" | "APPROVAL" | "NOTIFICATION";
  config: Record<string, unknown>;
  required: boolean;
  retryable: boolean;
  continueOnError: boolean;
}

interface StepConfigModalProps {
  nodeId: string;
  nodeData: StepNodeData;
  onClose: () => void;
  onUpdate: (updates: Partial<StepNodeData>) => void;
}

export default function StepConfigModal({ nodeData, onClose, onUpdate }: StepConfigModalProps) {
  const [label, setLabel] = useState(nodeData.label);
  const [required, setRequired] = useState(nodeData.required);
  const [retryable, setRetryable] = useState(nodeData.retryable);
  const [continueOnError, setContinueOnError] = useState(nodeData.continueOnError);
  const [config, setConfig] = useState(nodeData.config);

  useEffect(() => {
    setLabel(nodeData.label);
    setRequired(nodeData.required);
    setRetryable(nodeData.retryable);
    setContinueOnError(nodeData.continueOnError);
    setConfig(nodeData.config);
  }, [nodeData]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onUpdate({
      label,
      required,
      retryable,
      continueOnError,
      config,
    });
  };

  const renderConfigFields = () => {
    switch (nodeData.type) {
      case "SEARCH":
        return (
          <div className="space-y-3">
            <div>
              <Label>Minimum Seeds</Label>
              <Input
                type="number"
                value={(config.minSeeds as number) || 1}
                onChange={(e) =>
                  setConfig({ ...config, minSeeds: parseInt(e.target.value, 10) || 1 })
                }
                min={0}
              />
            </div>
            <div>
              <Label>Timeout (seconds)</Label>
              <Input
                type="number"
                value={(config.timeoutSeconds as number) || 300}
                onChange={(e) =>
                  setConfig({ ...config, timeoutSeconds: parseInt(e.target.value, 10) || 300 })
                }
                min={10}
              />
            </div>
          </div>
        );

      case "DOWNLOAD":
        return (
          <div className="space-y-3">
            <div>
              <Label>Max Download Time (hours)</Label>
              <Input
                type="number"
                value={(config.maxDownloadHours as number) || 24}
                onChange={(e) =>
                  setConfig({ ...config, maxDownloadHours: parseInt(e.target.value, 10) || 24 })
                }
                min={1}
              />
            </div>
          </div>
        );

      case "ENCODE":
        return (
          <div className="space-y-4">
            <div>
              <Label>Video Encoder</Label>
              <Select
                value={String(config.videoEncoder || "libsvtav1")}
                onChange={(e) => setConfig({ ...config, videoEncoder: e.target.value })}
                className="w-full"
              >
                <optgroup label="Software (CPU)">
                  <option value="libsvtav1">libsvtav1 (AV1)</option>
                  <option value="libx265">libx265 (HEVC/H.265)</option>
                  <option value="libx264">libx264 (H.264)</option>
                </optgroup>
                <optgroup label="Hardware (VAAPI)">
                  <option value="av1_vaapi">av1_vaapi (AV1 - Intel Arc)</option>
                  <option value="hevc_vaapi">hevc_vaapi (HEVC)</option>
                  <option value="h264_vaapi">h264_vaapi (H.264)</option>
                </optgroup>
                <optgroup label="Hardware (NVENC)">
                  <option value="av1_nvenc">av1_nvenc (AV1 - RTX 40 series)</option>
                  <option value="hevc_nvenc">hevc_nvenc (HEVC)</option>
                  <option value="h264_nvenc">h264_nvenc (H.264)</option>
                </optgroup>
                <optgroup label="Hardware (QSV)">
                  <option value="av1_qsv">av1_qsv (AV1 - Intel)</option>
                  <option value="hevc_qsv">hevc_qsv (HEVC)</option>
                  <option value="h264_qsv">h264_qsv (H.264)</option>
                </optgroup>
              </Select>
            </div>

            <div>
              <Label>Video Quality (CRF)</Label>
              <Input
                type="number"
                value={Number(config.crf || 28)}
                onChange={(e) => setConfig({ ...config, crf: parseInt(e.target.value, 10) || 28 })}
                min={0}
                max={51}
              />
              <p className="text-xs text-white/50 mt-1">
                Lower = better quality (18-28 recommended)
              </p>
            </div>

            <div>
              <Label>Max Resolution</Label>
              <Select
                value={String(config.maxResolution || "1080p")}
                onChange={(e) => setConfig({ ...config, maxResolution: e.target.value })}
                className="w-full"
              >
                <option value="480p">480p</option>
                <option value="720p">720p</option>
                <option value="1080p">1080p</option>
                <option value="2160p">4K (2160p)</option>
              </Select>
            </div>

            <div>
              <Label>Max Bitrate (kbps, optional)</Label>
              <Input
                type="number"
                value={config.maxBitrate !== undefined ? Number(config.maxBitrate) : ""}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    maxBitrate: e.target.value ? parseInt(e.target.value, 10) : undefined,
                  })
                }
                placeholder="Leave empty for no limit"
                min={0}
              />
            </div>

            <div>
              <Label>Hardware Acceleration</Label>
              <Select
                value={String(config.hwAccel || "NONE")}
                onChange={(e) => setConfig({ ...config, hwAccel: e.target.value })}
                className="w-full"
              >
                <option value="NONE">Software (CPU)</option>
                <option value="VAAPI">VAAPI (Intel Arc / AMD)</option>
                <option value="NVENC">NVENC (NVIDIA)</option>
                <option value="QSV">Quick Sync (Intel)</option>
                <option value="AMF">AMF (AMD)</option>
                <option value="VIDEOTOOLBOX">VideoToolbox (macOS)</option>
              </Select>
            </div>

            {config.hwAccel && config.hwAccel !== "NONE" ? (
              <div>
                <Label>Hardware Device Path (optional)</Label>
                <Input
                  value={String(config.hwDevice || "")}
                  onChange={(e) => setConfig({ ...config, hwDevice: e.target.value || undefined })}
                  placeholder="/dev/dri/renderD128"
                />
              </div>
            ) : null}

            <div>
              <Label>Encoding Preset</Label>
              <Select
                value={String(config.preset || "medium")}
                onChange={(e) => setConfig({ ...config, preset: e.target.value })}
                className="w-full"
              >
                <option value="fast">Fast</option>
                <option value="medium">Medium (balanced)</option>
                <option value="slow">Slow (best quality)</option>
              </Select>
              <p className="text-xs text-white/50 mt-1">Speed vs quality tradeoff</p>
            </div>

            <div>
              <Label>Audio Encoder</Label>
              <Select
                value={String(config.audioEncoder || "copy")}
                onChange={(e) => setConfig({ ...config, audioEncoder: e.target.value })}
                className="w-full"
              >
                <option value="copy">Copy (passthrough)</option>
                <option value="aac">AAC</option>
                <option value="libopus">Opus</option>
                <option value="ac3">AC3 (Dolby Digital)</option>
                <option value="eac3">EAC3 (Dolby Digital Plus)</option>
              </Select>
            </div>

            <div>
              <Label>Subtitles</Label>
              <Select
                value={String(config.subtitlesMode || "COPY")}
                onChange={(e) => setConfig({ ...config, subtitlesMode: e.target.value })}
                className="w-full"
              >
                <option value="COPY">Copy all tracks</option>
                <option value="COPY_TEXT">Copy text tracks only</option>
                <option value="EXTRACT">Extract to separate files</option>
                <option value="NONE">Remove subtitles</option>
              </Select>
            </div>

            <div>
              <Label>Container Format</Label>
              <Select
                value={String(config.container || "MKV")}
                onChange={(e) => setConfig({ ...config, container: e.target.value })}
                className="w-full"
              >
                <option value="MKV">MKV (recommended)</option>
                <option value="MP4">MP4 (wider compatibility)</option>
                <option value="WEBM">WebM</option>
              </Select>
            </div>

            <div>
              <Label>Remove Dolby Vision</Label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={(config.removeDolbyVision as boolean) ?? false}
                  onChange={(e) => setConfig({ ...config, removeDolbyVision: e.target.checked })}
                />
                <span className="text-sm text-white/70">
                  Strip Dolby Vision metadata (preserves HDR10 base layer)
                </span>
              </label>
            </div>
          </div>
        );

      case "DELIVER":
        return (
          <div className="space-y-3">
            <div>
              <Label>Verify Delivery</Label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={(config.verifyDelivery as boolean) ?? true}
                  onChange={(e) => setConfig({ ...config, verifyDelivery: e.target.checked })}
                />
                <span className="text-sm text-white/70">Verify file integrity after delivery</span>
              </label>
            </div>
          </div>
        );

      case "APPROVAL":
        return (
          <div className="space-y-3">
            <div>
              <Label>Timeout (hours)</Label>
              <Input
                type="number"
                value={(config.timeoutHours as number) || 24}
                onChange={(e) =>
                  setConfig({ ...config, timeoutHours: parseInt(e.target.value, 10) || 24 })
                }
                min={1}
              />
              <p className="text-xs text-white/50 mt-1">
                Auto-reject if not approved within timeout
              </p>
            </div>
            <div>
              <Label>Default Action on Timeout</Label>
              <Select
                value={(config.defaultAction as string) || "REJECT"}
                onChange={(e) => setConfig({ ...config, defaultAction: e.target.value })}
                className="w-full"
              >
                <option value="APPROVE">Approve</option>
                <option value="REJECT">Reject</option>
              </Select>
            </div>
          </div>
        );

      case "NOTIFICATION":
        return (
          <div className="space-y-3">
            <div>
              <Label>Event Type</Label>
              <Select
                value={(config.event as string) || "REQUEST_SUBMITTED"}
                onChange={(e) => setConfig({ ...config, event: e.target.value })}
                className="w-full"
              >
                <option value="REQUEST_SUBMITTED">Request Submitted</option>
                <option value="REQUEST_COMPLETED">Request Completed</option>
                <option value="REQUEST_FAILED">Request Failed</option>
                <option value="APPROVAL_REQUIRED">Approval Required</option>
              </Select>
            </div>
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex" onClick={onClose}>
      <div className="flex-1" />
      <Card
        className="w-full max-w-md h-full overflow-y-auto p-6 rounded-none border-l border-white/10 animate-slide-in-right"
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold text-white">Configure {nodeData.type} Step</h2>
          <button
            onClick={onClose}
            className="text-white/50 hover:text-white transition-colors"
            type="button"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Label>Step Name</Label>
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Enter step name"
              required
            />
          </div>

          {renderConfigFields()}

          <div className="pt-4 border-t border-white/10">
            <h3 className="text-sm font-semibold text-white mb-3">Behavior</h3>
            <div className="space-y-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={required}
                  onChange={(e) => setRequired(e.target.checked)}
                />
                <span className="text-sm text-white/70">
                  Required - Pipeline fails if this step fails
                </span>
              </label>

              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={retryable}
                  onChange={(e) => setRetryable(e.target.checked)}
                />
                <span className="text-sm text-white/70">
                  Retryable - Allow manual retry on failure
                </span>
              </label>

              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={continueOnError}
                  onChange={(e) => setContinueOnError(e.target.checked)}
                />
                <span className="text-sm text-white/70">
                  Continue on error - Don't halt pipeline on failure
                </span>
              </label>
            </div>
          </div>

          <div className="flex gap-2 pt-4">
            <Button type="submit">Save Changes</Button>
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
