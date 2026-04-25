import { useEffect, useMemo, useRef } from "react";
import { getVsCodeApi } from "../vscode-api";
import type {
  EditedSection,
  GemmaFlags,
  GemmaUnavailable,
  InboundMessage,
  Mode,
  NewRequest,
  Snapshot,
  TimeoutWarning,
} from "../types";

interface Handlers {
  onNewRequest: (msg: NewRequest) => void;
  onGemmaFlags: (msg: GemmaFlags) => void;
  onGemmaUnavailable?: (msg: GemmaUnavailable) => void;
  onSnapshot?: (msg: Snapshot) => void;
  onTimeoutWarning?: (msg: TimeoutWarning) => void;
}

export function useWebSocket(handlers: Handlers) {
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const data = event.data as InboundMessage | undefined;
      if (!data || typeof data !== "object" || !("type" in data)) return;
      switch (data.type) {
        case "new_request":
          handlersRef.current.onNewRequest(data);
          break;
        case "gemma_flags":
          handlersRef.current.onGemmaFlags(data);
          break;
        case "gemma_unavailable":
          handlersRef.current.onGemmaUnavailable?.(data);
          break;
        case "snapshot":
          handlersRef.current.onSnapshot?.(data);
          break;
        case "timeout_warning":
          handlersRef.current.onTimeoutWarning?.(data);
          break;
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  return useMemo(() => {
    const api = getVsCodeApi();
    return {
      sendApprove(requestId: string) {
        api.postMessage({ type: "approve", requestId });
      },
      sendApproveModified(
        requestId: string,
        removedIndices: number[],
        editedSections: EditedSection[],
      ) {
        api.postMessage({
          type: "approve_modified",
          requestId,
          removedIndices,
          editedSections,
        });
      },
      sendModeChange(mode: Mode) {
        api.postMessage({ type: "mode_change", mode });
      },
      sendPauseToggle(paused: boolean) {
        api.postMessage({ type: "pause_toggle", paused });
      },
      sendRequestFlagging(requestId: string, sectionIndex: number) {
        api.postMessage({ type: "request_flagging", requestId, sectionIndex });
      },
      sendResetCanonical() {
        api.postMessage({ type: "reset_canonical" });
      },
    };
  }, []);
}

export type WebSocketSenders = ReturnType<typeof useWebSocket>;
