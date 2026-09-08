/**
 * Map d'icônes centrale (lucide-react).
 *
 * Une icône = un sens, cohérent dans toute l'app. On référence toujours via
 * `icons.<sens>` plutôt que d'importer Lucide en direct, pour garantir la
 * cohérence. Trait 1.75px, taille 18px par défaut (réglage optique soigné).
 */
'use client';

import {
  Archive,
  ArrowLeft,
  ArrowRight,
  BarChart3,
  Bell,
  Calendar,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleAlert,
  Clock,
  Columns2,
  Maximize2,
  Minimize2,
  MoveHorizontal,
  Printer,
  RotateCw,
  ScrollText,
  Command as CommandIcon,
  Download,
  Eye,
  FileText,
  Filter,
  FolderOpen,
  FolderTree,
  Inbox,
  LayoutDashboard,
  Loader2,
  Lock,
  LogOut,
  Mail,
  MapPin,
  Menu,
  Moon,
  Network,
  Pencil,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  QrCode,
  RefreshCw,
  RotateCcw,
  ScanLine,
  Search,
  Send,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Tags,
  Trash2,
  Upload,
  Users,
  Wrench,
  X,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from 'lucide-react';

export type { LucideIcon };

/** Props par défaut appliquées partout (sauf override ponctuel). */
export const iconDefaults = { size: 18, strokeWidth: 1.75 } as const;

/** Map sémantique : le nom décrit le sens métier, pas le glyphe. */
export const icons = {
  // Navigation principale
  dashboard: LayoutDashboard,
  analytics: BarChart3,
  intercalaires: QrCode,
  acquisition: Inbox,
  search: Search,
  settings: Settings,
  tune: SlidersHorizontal,
  admin: Wrench,

  // Référentiels (Paramétrage)
  geolocalisation: MapPin,
  classification: Network,
  dossier: FolderOpen,
  documentType: Tags,
  users: Users,
  roles: ShieldCheck,

  // Objets métier
  document: FileText,
  archive: Archive,
  qr: QrCode,
  scan: ScanLine,
  folderTree: FolderTree,
  dates: Calendar,

  // Docu-Courriers
  mail: Mail,
  send: Send,
  notifications: Bell,
  organigramme: Network,

  // Actions
  add: Plus,
  edit: Pencil,
  delete: Trash2,
  download: Download,
  upload: Upload,
  view: Eye,
  filter: Filter,
  reset: RotateCcw,
  refresh: RefreshCw,
  logout: LogOut,
  lock: Lock,
  close: X,
  menu: Menu,
  command: CommandIcon,
  collapse: PanelLeftClose,
  expand: PanelLeftOpen,

  // États / statuts
  validated: CheckCircle2,
  pending: Clock,
  check: Check,
  alert: CircleAlert,
  spinner: Loader2,
  sparkle: Sparkles,

  // Visionneuse PDF
  zoomIn: ZoomIn,
  zoomOut: ZoomOut,
  fitWidth: MoveHorizontal,
  fitPage: ScrollText,
  rotateLeft: RotateCcw,
  rotateRight: RotateCw,
  print: Printer,
  fullscreen: Maximize2,
  fullscreenExit: Minimize2,
  thumbnails: Columns2,

  // Direction
  chevronRight: ChevronRight,
  chevronLeft: ChevronLeft,
  chevronUp: ChevronUp,
  chevronDown: ChevronDown,
  arrowRight: ArrowRight,
  arrowLeft: ArrowLeft,

  // Thème
  light: Sun,
  dark: Moon,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof icons;
