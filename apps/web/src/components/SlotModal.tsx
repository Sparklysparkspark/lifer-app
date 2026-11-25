import { createContext, useContext, useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import Modal, { type ModalProps } from "./Modal";

type Slots = {
  footerEl: HTMLElement | null;
  startEl: HTMLElement | null;
  submitRef: RefObject<((e: FormEvent<HTMLFormElement>) => void) | null>;
};
const SlotsContext = createContext<Slots | null>(null);

/** A Modal whose footer buttons and submit handler come from its body, so one dialog can swap
 *  bodies (tabs) without closing and reopening. The body renders <ModalFooter> and calls
 *  useModalSubmit. */
export default function SlotModal({
  children,
  ...props
}: Omit<ModalProps, "open" | "footer" | "footerStart" | "onSubmit">) {
  const [footerEl, setFooterEl] = useState<HTMLElement | null>(null);
  const [startEl, setStartEl] = useState<HTMLElement | null>(null);
  const submitRef = useRef<((e: FormEvent<HTMLFormElement>) => void) | null>(null);
  return (
    <SlotsContext.Provider value={{ footerEl, startEl, submitRef }}>
      <Modal
        open
        {...props}
        // display: contents keeps the portaled buttons laid out (and platform-ordered) by the footer row.
        footer={<div ref={setFooterEl} className="contents" />}
        footerStart={<div ref={setStartEl} className="contents" />}
        onSubmit={(e) => submitRef.current?.(e)}
      >
        {children}
      </Modal>
    </SlotsContext.Provider>
  );
}

/** The body's footer buttons (Cancel, then the primary action); `start` is a tertiary action
 *  (Back) pinned to the footer's start. */
export function ModalFooter({ children, start }: { children: React.ReactNode; start?: boolean }) {
  const slots = useContext(SlotsContext);
  const el = start ? slots?.startEl : slots?.footerEl;
  return el ? createPortal(children, el) : null;
}

/** What Enter in a field and a footer type="submit" button do. */
export function useModalSubmit(onSubmit: (e: FormEvent<HTMLFormElement>) => void) {
  const slots = useContext(SlotsContext);
  useEffect(() => {
    if (!slots) return;
    const ref = slots.submitRef;
    ref.current = onSubmit;
    return () => {
      ref.current = null;
    };
  });
}
