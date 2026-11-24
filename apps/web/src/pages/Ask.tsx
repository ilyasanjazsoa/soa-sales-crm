import { AskResponse } from "@soa/shared";
import { useMutation } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { api } from "../api";
import { Btn, Empty, ErrorState, Modal, Panel } from "../ui";

/* Ask Sales AI (§11.2): answers come from fixed, read-only CRM queries run under your own access. */

const EXAMPLES = ["What's stalled?", "Who am I meeting this week?", "What's my forecast?", "Any replies this week?"];

function AskBox({ autoFocus = false, onNavigate }: { autoFocus?: boolean; onNavigate?: () => void }) {
  const [question, setQuestion] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const ask = useMutation({
    mutationFn: (text: string) => api("/api/ask", AskResponse, { method: "POST", body: { question: text } }),
  });
  useEffect(() => {
    if (autoFocus) input.current?.focus();
  }, [autoFocus]);
  const submit = (text: string) => {
    if (text.trim().length < 2) return;
    setQuestion(text);
    ask.mutate(text.trim());
  };
  return (
    <div className="space-y-3">
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          submit(question);
        }}
      >
        <input
          ref={input}
          aria-label="Ask a question"
          placeholder="Ask about your deals, meetings, replies or accounts"
          className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-400 outline-none focus:border-blue-500"
          value={question}
          maxLength={500}
          onChange={(event) => {
            setQuestion(event.target.value);
          }}
        />
        <Btn type="submit" kind="blue" icon={Sparkles} busy={ask.isPending}>
          Ask
        </Btn>
      </form>
      <div className="flex flex-wrap gap-2">
        {EXAMPLES.map((example) => (
          <button
            key={example}
            type="button"
            className="rounded-full border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:border-zinc-500"
            onClick={() => {
              submit(example);
            }}
          >
            {example}
          </button>
        ))}
      </div>
      {ask.isError && <ErrorState error={ask.error} />}
      {ask.data !== undefined && (
        <div className="space-y-2 rounded-lg border border-blue-900 bg-blue-950/20 p-3" aria-live="polite">
          <p className="text-sm text-zinc-100">{ask.data.answer}</p>
          {ask.data.items.length > 0 && (
            <ul className="divide-y divide-zinc-800">
              {ask.data.items.map((item, index) => (
                <li key={`${String(index)}-${item.link}`} className="py-1.5">
                  <Link to={item.link} onClick={onNavigate} className="text-sm text-blue-300 hover:underline">
                    {item.label}
                  </Link>
                  {item.sub !== "" && <p className="text-xs text-zinc-400">{item.sub}</p>}
                </li>
              ))}
            </ul>
          )}
          <p className="text-[11px] text-zinc-400">
            Answered from CRM data you can see. The AI can make mistakes; check before acting.
          </p>
        </div>
      )}
    </div>
  );
}

export function AskPage() {
  return (
    <Panel title="Ask Sales AI" icon={Sparkles}>
      <AskBox autoFocus />
      <div className="mt-4">
        <Empty>Tip: press Ctrl+K (⌘K on a Mac) anywhere to ask.</Empty>
      </div>
    </Panel>
  );
}

/** Ctrl/⌘+K from anywhere opens the question box. */
export function AskPalette() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        // Not on top of another dialog (one Escape would close both).
        if (document.querySelector('[role="dialog"]:not([aria-label="Ask Sales AI"])') !== null) return;
        setOpen((value) => !value);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
    };
  }, []);
  if (!open) return null;
  return (
    <Modal
      title="Ask Sales AI"
      wide
      onClose={() => {
        setOpen(false);
      }}
    >
      <AskBox
        autoFocus
        onNavigate={() => {
          setOpen(false);
        }}
      />
      <p className="mt-3 text-xs text-zinc-400">
        <button
          type="button"
          className="underline"
          onClick={() => {
            setOpen(false);
            void navigate("/ask");
          }}
        >
          Open the full page
        </button>
      </p>
    </Modal>
  );
}
