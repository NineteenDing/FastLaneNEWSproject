import { useEffect, useRef } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import Image from "@tiptap/extension-image";
import { isManagedImageUrl } from "../image-references.ts";
import type { WritingImage } from "../contracts";

const ManagedImage = Image.extend({
  parseHTML() { return [{ tag: "img[src]", getAttrs: element => isManagedImageUrl(element.getAttribute("src")) ? null : false }]; },
  renderHTML({ HTMLAttributes }) {
    return isManagedImageUrl(HTMLAttributes.src) ? ["img", { ...HTMLAttributes, loading: "lazy" }]
      : ["span", { class: "studio-writing-image-unavailable" }, "外链图片尚未导入，请先上传到本稿素材。"];
  },
});

export function WritingEditor({ value, onChange, label, onPasteImage, onImageWarning, readOnly = false, onActivate, onLeave, images = [], onManagedImage }: { value: string; onChange(value: string): void; label: string;
  onPasteImage?(file: File): Promise<string | null>; onImageWarning?(message: string): void; readOnly?: boolean; onActivate?(): void; onLeave?(): void;
  images?: WritingImage[]; onManagedImage?(image: WritingImage): boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onPasteImage, onImageWarning, onActivate, onLeave, images, onManagedImage }); callbacks.current = { onPasteImage, onImageWarning, onActivate, onLeave, images, onManagedImage };
  const editor = useEditor({ extensions: [StarterKit.configure({ link: { openOnClick: false, autolink: false } }), Markdown, ManagedImage],
    content: value, contentType: "markdown", immediatelyRender: false, editable: !readOnly,
    editorProps: { attributes: { role: "textbox", "aria-label": label, "aria-multiline": "true", spellcheck: "false" },
      handlePaste(view, event) {
        const file = [...(event.clipboardData?.files ?? [])].find(item => item.type.startsWith("image/"));
        if (file && callbacks.current.onPasteImage) {
          event.preventDefault();
          void callbacks.current.onPasteImage(file).then(src => {
            if (src && !view.isDestroyed) view.dispatch(view.state.tr.replaceSelectionWith(view.state.schema.nodes.image!.create({ src, alt: file.name })));
          }).catch(() => callbacks.current.onImageWarning?.("图片未能插入，请重试上传。"));
          return true;
        }
        if (event.clipboardData?.getData("text/html").includes("<img")) callbacks.current.onImageWarning?.("外链图片不会直接加载；请先下载后上传到本稿素材。");
        return false;
      },
    },
    onUpdate: ({ editor }) => onChange(editor.getMarkdown()),
  });
  function dropImage(event: DragEvent) {
        if (!editor) return;
        const view = editor.view;
        const raw = event.dataTransfer?.getData("application/x-fastlanenews-image"), file = [...(event.dataTransfer?.files ?? [])].find(item => item.type.startsWith("image/"));
        const position = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? view.state.selection.from;
        if (raw) {
          const image = callbacks.current.images.find(image => image.assetId === raw);
          event.preventDefault(); event.stopPropagation();
          if (!image) { callbacks.current.onImageWarning?.("只能拖入本稿已有图片，请先上传到本稿素材。"); return; }
          if (callbacks.current.onManagedImage?.(image) === false) return;
          callbacks.current.onActivate?.(); view.dispatch(view.state.tr.insert(position, view.state.schema.nodes.image!.create({ src: image.url, alt: image.name }))); return;
        }
        if (file && callbacks.current.onPasteImage) {
          event.preventDefault(); event.stopPropagation(); callbacks.current.onActivate?.();
          void callbacks.current.onPasteImage(file).then(src => {
            if (src && !view.isDestroyed) view.dispatch(view.state.tr.insert(Math.min(position, view.state.doc.content.size), view.state.schema.nodes.image!.create({ src, alt: file.name })));
          }).catch(() => callbacks.current.onImageWarning?.("图片未能插入，请重试上传。")); return;
        }
        if (event.dataTransfer?.getData("text/html").includes("<img")) callbacks.current.onImageWarning?.("外链图片需先上传到本稿素材。");
  }
  useEffect(() => { if (editor && editor.getMarkdown() !== value) editor.commands.setContent(value, { contentType: "markdown", emitUpdate: false }); }, [editor, value]);
  useEffect(() => { editor?.setEditable(!readOnly, false); }, [editor, readOnly]);
  return <div ref={root} className={`studio-rich-editor${readOnly ? " studio-writing-preview" : ""}`} onDragOver={event => {
    if (event.dataTransfer.types.includes("application/x-fastlanenews-image") || event.dataTransfer.types.includes("Files")) event.preventDefault();
  }} onDropCapture={event => dropImage(event.nativeEvent)} onClick={event => {
    if (readOnly && onActivate && !(event.target as Element).closest("a,button")) onActivate();
  }} onKeyDown={event => { if (readOnly && onActivate && event.key === "Enter") { event.preventDefault(); onActivate(); } }}
    onBlur={event => { if (!readOnly && !root.current?.contains(event.relatedTarget as Node | null)) callbacks.current.onLeave?.(); }}>
    <div className="studio-editor-toolbar" role="toolbar" aria-label="正文格式" aria-hidden={readOnly} inert={readOnly}>
    <button type="button" disabled={readOnly || !editor} onClick={() => editor?.chain().focus().toggleBold().run()}>加粗</button>
    <button type="button" disabled={readOnly || !editor} onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}>小标题</button>
    <button type="button" disabled={readOnly || !editor} onClick={() => editor?.chain().focus().toggleBulletList().run()}>列表</button>
    <button type="button" disabled={readOnly || !editor?.can().undo()} onClick={() => editor?.chain().focus().undo().run()}>撤销</button>
    <button type="button" disabled={readOnly || !editor?.can().redo()} onClick={() => editor?.chain().focus().redo().run()}>重做</button>
  </div>{editor ? <EditorContent editor={editor} /> : <p className="studio-caption">正在打开编辑器…</p>}</div>;
}
