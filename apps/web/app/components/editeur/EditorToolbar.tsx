'use client';

import { useCallback, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Dropdown, Form, Input, Modal } from 'antd';
import { useEditorState, type Editor } from '@tiptap/react';
import {
  AtSign,
  Bold,
  Code2,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link2,
  List,
  ListOrdered,
  MessageSquarePlus,
  Quote,
  Redo2,
  Strikethrough,
  Table2,
  Underline,
  Undo2,
  Unlink,
} from 'lucide-react';
import { iconDefaults } from '../../theme/icons';
import styles from './editeur.module.css';

const ICON = { size: 17, strokeWidth: iconDefaults.strokeWidth } as const;

/** Appel dynamique d'une commande Tiptap : certaines (table) dépendent du schéma partagé. */
type Chain = Record<string, (...args: unknown[]) => Chain> & { run: () => boolean };
const chainOf = (editor: Editor): Chain => editor.chain().focus() as unknown as Chain;

function ToolBtn({
  id,
  label,
  pressed,
  disabled,
  tabStop,
  onFocusBtn,
  onClick,
  children,
}: {
  id: string;
  label: string;
  pressed?: boolean;
  disabled?: boolean;
  tabStop: string;
  onFocusBtn: (id: string) => void;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      data-tb={id}
      className={styles.toolBtn}
      aria-label={label}
      title={label}
      aria-pressed={pressed === undefined ? undefined : pressed}
      disabled={disabled}
      tabIndex={tabStop === id ? 0 : -1}
      onFocus={() => onFocusBtn(id)}
      // Garde la sélection de l'éditeur : le clic ne doit pas lui voler le focus.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function EditorToolbar({
  editor,
  readOnly,
  onComment,
  canComment,
}: {
  editor: Editor;
  readOnly: boolean;
  onComment: () => void;
  canComment: boolean;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const [tabStop, setTabStop] = useState('bold');
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkForm] = Form.useForm<{ href: string }>();

  const st = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      underline: e.isActive('underline'),
      strike: e.isActive('strike'),
      h1: e.isActive('heading', { level: 1 }),
      h2: e.isActive('heading', { level: 2 }),
      h3: e.isActive('heading', { level: 3 }),
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      quote: e.isActive('blockquote'),
      code: e.isActive('codeBlock'),
      link: e.isActive('link'),
      inTable: e.isActive('table'),
      hasSelection: !e.state.selection.empty,
      canUndo: e.can().chain().focus().undo().run(),
      canRedo: e.can().chain().focus().redo().run(),
    }),
  });

  const dis = readOnly;
  const has = (name: string) => !!editor.schema.nodes[name] || !!editor.schema.marks[name];

  const onKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    const keys = ['ArrowRight', 'ArrowLeft', 'Home', 'End'];
    if (!keys.includes(e.key) || !barRef.current) return;
    const items = Array.from(barRef.current.querySelectorAll<HTMLButtonElement>('button[data-tb]:not(:disabled)'));
    if (items.length === 0) return;
    const cur = items.findIndex((b) => b === document.activeElement);
    let next = cur;
    if (e.key === 'ArrowRight') next = (cur + 1) % items.length;
    else if (e.key === 'ArrowLeft') next = (cur - 1 + items.length) % items.length;
    else if (e.key === 'Home') next = 0;
    else next = items.length - 1;
    e.preventDefault();
    items[next]?.focus();
  }, []);

  const props = (id: string) => ({ id, tabStop, onFocusBtn: setTabStop });

  const openLink = () => {
    const current = (editor.getAttributes('link').href as string | undefined) ?? '';
    linkForm.setFieldsValue({ href: current });
    setLinkOpen(true);
  };
  const applyLink = (href: string) => {
    const url = href.trim();
    const chain = editor.chain().focus().extendMarkRange('link');
    if (!url) chain.unsetMark('link').run();
    else chain.setMark('link', { href: url }).run();
    setLinkOpen(false);
  };

  const tableItems = [
    { key: 'insert', label: 'Insérer un tableau 3 × 3', disabled: st.inTable },
    { key: 'addRowAfter', label: 'Ajouter une ligne', disabled: !st.inTable },
    { key: 'addColumnAfter', label: 'Ajouter une colonne', disabled: !st.inTable },
    { key: 'deleteRow', label: 'Supprimer la ligne', disabled: !st.inTable },
    { key: 'deleteColumn', label: 'Supprimer la colonne', disabled: !st.inTable },
    { key: 'deleteTable', label: 'Supprimer le tableau', disabled: !st.inTable, danger: true },
  ];

  return (
    <>
      <div
        ref={barRef}
        className={styles.toolbar}
        role="toolbar"
        aria-label="Mise en forme du document"
        aria-orientation="horizontal"
        onKeyDown={onKeyDown}
      >
        <span className={styles.toolbarGroup} role="group" aria-label="Historique">
          <ToolBtn {...props('undo')} label="Annuler" disabled={dis || !st.canUndo} onClick={() => chainOf(editor).undo!().run()}>
            <Undo2 {...ICON} />
          </ToolBtn>
          <ToolBtn {...props('redo')} label="Rétablir" disabled={dis || !st.canRedo} onClick={() => chainOf(editor).redo!().run()}>
            <Redo2 {...ICON} />
          </ToolBtn>
        </span>
        <span className={styles.toolbarSep} aria-hidden="true" />
        <span className={styles.toolbarGroup} role="group" aria-label="Titres">
          <ToolBtn {...props('h1')} label="Titre 1" pressed={st.h1} disabled={dis} onClick={() => editor.chain().focus().toggleNode('heading', 'paragraph', { level: 1 }).run()}>
            <Heading1 {...ICON} />
          </ToolBtn>
          <ToolBtn {...props('h2')} label="Titre 2" pressed={st.h2} disabled={dis} onClick={() => editor.chain().focus().toggleNode('heading', 'paragraph', { level: 2 }).run()}>
            <Heading2 {...ICON} />
          </ToolBtn>
          <ToolBtn {...props('h3')} label="Titre 3" pressed={st.h3} disabled={dis} onClick={() => editor.chain().focus().toggleNode('heading', 'paragraph', { level: 3 }).run()}>
            <Heading3 {...ICON} />
          </ToolBtn>
        </span>
        <span className={styles.toolbarSep} aria-hidden="true" />
        <span className={styles.toolbarGroup} role="group" aria-label="Style du texte">
          <ToolBtn {...props('bold')} label="Gras (Ctrl+B)" pressed={st.bold} disabled={dis} onClick={() => editor.chain().focus().toggleMark('bold').run()}>
            <Bold {...ICON} />
          </ToolBtn>
          <ToolBtn {...props('italic')} label="Italique (Ctrl+I)" pressed={st.italic} disabled={dis} onClick={() => editor.chain().focus().toggleMark('italic').run()}>
            <Italic {...ICON} />
          </ToolBtn>
          <ToolBtn {...props('underline')} label="Souligné (Ctrl+U)" pressed={st.underline} disabled={dis} onClick={() => editor.chain().focus().toggleMark('underline').run()}>
            <Underline {...ICON} />
          </ToolBtn>
          <ToolBtn {...props('strike')} label="Barré" pressed={st.strike} disabled={dis} onClick={() => editor.chain().focus().toggleMark('strike').run()}>
            <Strikethrough {...ICON} />
          </ToolBtn>
        </span>
        <span className={styles.toolbarSep} aria-hidden="true" />
        <span className={styles.toolbarGroup} role="group" aria-label="Blocs">
          <ToolBtn {...props('bullet')} label="Liste à puces" pressed={st.bullet} disabled={dis} onClick={() => editor.chain().focus().toggleList('bulletList', 'listItem').run()}>
            <List {...ICON} />
          </ToolBtn>
          <ToolBtn {...props('ordered')} label="Liste numérotée" pressed={st.ordered} disabled={dis} onClick={() => editor.chain().focus().toggleList('orderedList', 'listItem').run()}>
            <ListOrdered {...ICON} />
          </ToolBtn>
          <ToolBtn {...props('quote')} label="Citation" pressed={st.quote} disabled={dis} onClick={() => editor.chain().focus().toggleWrap('blockquote').run()}>
            <Quote {...ICON} />
          </ToolBtn>
          <ToolBtn {...props('code')} label="Bloc de code" pressed={st.code} disabled={dis} onClick={() => editor.chain().focus().toggleNode('codeBlock', 'paragraph').run()}>
            <Code2 {...ICON} />
          </ToolBtn>
        </span>
        <span className={styles.toolbarSep} aria-hidden="true" />
        <span className={styles.toolbarGroup} role="group" aria-label="Insertions">
          <ToolBtn {...props('link')} label={st.link ? 'Modifier le lien' : 'Insérer un lien'} pressed={st.link} disabled={dis || !has('link')} onClick={openLink}>
            <Link2 {...ICON} />
          </ToolBtn>
          {st.link && (
            <ToolBtn {...props('unlink')} label="Retirer le lien" disabled={dis} onClick={() => editor.chain().focus().extendMarkRange('link').unsetMark('link').run()}>
              <Unlink {...ICON} />
            </ToolBtn>
          )}
          <Dropdown
            trigger={['click']}
            disabled={dis || !has('table')}
            menu={{
              items: tableItems,
              onClick: ({ key }) => {
                const c = chainOf(editor);
                if (key === 'insert') c.insertTable?.({ rows: 3, cols: 3, withHeaderRow: true }).run();
                else c[key]?.().run();
              },
            }}
          >
            <button
              type="button"
              data-tb="table"
              className={styles.toolBtn}
              aria-label="Tableau"
              title="Tableau"
              aria-haspopup="menu"
              aria-pressed={st.inTable}
              disabled={dis || !has('table')}
              tabIndex={tabStop === 'table' ? 0 : -1}
              onFocus={() => setTabStop('table')}
            >
              <Table2 {...ICON} />
            </button>
          </Dropdown>
          <ToolBtn {...props('mention')} label="Mentionner une personne (@)" disabled={dis || !has('mention')} onClick={() => editor.chain().focus().insertContent('@').run()}>
            <AtSign {...ICON} />
          </ToolBtn>
        </span>
        <span className={styles.toolbarSep} aria-hidden="true" />
        <span className={styles.toolbarGroup} role="group" aria-label="Commentaires">
          <ToolBtn {...props('comment')} label="Commenter la sélection" disabled={!canComment || !st.hasSelection} onClick={onComment}>
            <MessageSquarePlus {...ICON} />
          </ToolBtn>
        </span>
      </div>

      <Modal
        title="Lien"
        open={linkOpen}
        okText="Appliquer"
        cancelText="Annuler"
        onCancel={() => setLinkOpen(false)}
        onOk={() => linkForm.submit()}
        destroyOnHidden
        forceRender
      >
        <Form form={linkForm} layout="vertical" onFinish={(v) => applyLink(v.href ?? '')}>
          <Form.Item
            name="href"
            label="Adresse (URL)"
            extra="Laissez vide pour retirer le lien."
            rules={[
              {
                validator: (_, v: string | undefined) =>
                  !v || /^(https?:\/\/|mailto:)/i.test(v.trim())
                    ? Promise.resolve()
                    : Promise.reject(new Error('L’adresse doit commencer par https://, http:// ou mailto:')),
              },
            ]}
          >
            <Input placeholder="https://exemple.fr" autoFocus />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
