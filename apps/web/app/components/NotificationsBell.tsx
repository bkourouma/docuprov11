'use client';

import { useCallback, useEffect, useState, type KeyboardEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Badge, Button, Dropdown, Empty, List, Spin, Tooltip, Typography } from 'antd';
import dayjs from 'dayjs';
import { icons } from '../theme/icons';
import { radii } from '../theme/tokens';
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  unreadNotificationCount,
  type NotificationRow,
} from '../lib/courriers';

/** Intervalle de rafraîchissement du badge — comptage par POLLING (pas de websocket, cf. décision v1). */
const POLL_MS = 60_000;

/**
 * Cloche de notifications : badge « non lues » rafraîchi par polling + inbox déroulante.
 * Chaque acteur ne voit que ses propres notifications (le back filtre sur son user_group).
 */
export function NotificationsBell() {
  const router = useRouter();
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<NotificationRow[]>([]);
  const [loading, setLoading] = useState(false);

  const refreshCount = useCallback(async () => {
    const res = await unreadNotificationCount().catch(() => null);
    if (res) setUnread(res.count);
  }, []);

  useEffect(() => {
    void refreshCount();
    const id = setInterval(() => void refreshCount(), POLL_MS);
    return () => clearInterval(id);
  }, [refreshCount]);

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listNotifications({ page: 1, pageSize: 10 });
      setRows(res.rows);
      setUnread(res.unread);
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) void loadList();
  };

  const readOne = async (n: NotificationRow) => {
    if (n.isRead) return;
    await markNotificationRead(n.notificationId).catch(() => undefined);
    setRows((rs) =>
      rs.map((r) => (r.notificationId === n.notificationId ? { ...r, isRead: true } : r)),
    );
    setUnread((u) => Math.max(0, u - 1));
  };

  /** Destination d'une notification : seul un document de l'éditeur en a une (les autres : comportement inchangé). */
  const destinationOf = (n: NotificationRow): string | null =>
    n.targetType === 'document' && n.targetId != null ? `/editeur/${n.targetId}` : null;

  const openNotification = (n: NotificationRow, href: string) => {
    setOpen(false);
    void readOne(n);
    router.push(href);
  };

  const readAll = async () => {
    await markAllNotificationsRead().catch(() => undefined);
    setRows((rs) => rs.map((r) => ({ ...r, isRead: true })));
    setUnread(0);
  };

  const panel = (
    <div
      style={{
        width: 360,
        // Laisse le panneau rétrécir dans le conteneur ramené à la fenêtre sur mobile.
        maxWidth: '100%',
        background: 'var(--ant-color-bg-elevated, #fff)',
        borderRadius: radii.card,
        border: '1px solid var(--ant-color-border-secondary, #d9e2ea)',
        boxShadow: 'var(--da-shadow-popover, 0 3px 21px rgba(0,0,0,0.2))',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '10px 12px',
          borderBottom: '1px solid var(--ant-color-border-secondary)',
        }}
      >
        <Typography.Text strong>Notifications</Typography.Text>
        <Button type="link" size="small" disabled={unread === 0} onClick={() => void readAll()}>
          Tout marquer lu
        </Button>
      </div>
      {loading ? (
        <div style={{ display: 'grid', placeItems: 'center', padding: 32 }}>
          <Spin size="small" />
        </div>
      ) : rows.length === 0 ? (
        <div style={{ padding: 24 }}>
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Aucune notification" />
        </div>
      ) : (
        <List
          size="small"
          style={{ maxHeight: 380, overflow: 'auto' }}
          dataSource={rows}
          renderItem={(n) => {
            const href = destinationOf(n);
            const onKeyDown = (e: KeyboardEvent) => {
              if (href && (e.key === 'Enter' || e.key === ' ')) {
                e.preventDefault();
                openNotification(n, href);
              }
            };
            return (
            <List.Item
              onClick={() => (href ? openNotification(n, href) : void readOne(n))}
              {...(href ? { role: 'link', tabIndex: 0, onKeyDown, 'aria-label': n.message } : {})}
              style={{
                cursor: href || !n.isRead ? 'pointer' : 'default',
                padding: '10px 12px',
                background: n.isRead ? undefined : 'var(--ant-color-primary-bg, #e3efe7)',
              }}
            >
              <List.Item.Meta
                title={
                  <Typography.Text style={{ fontWeight: n.isRead ? 400 : 600, fontSize: 13 }}>
                    {n.message}
                  </Typography.Text>
                }
                description={
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {dayjs(n.createdAt).format('DD/MM/YYYY HH:mm')}
                  </Typography.Text>
                }
              />
            </List.Item>
            );
          }}
        />
      )}
    </div>
  );

  return (
    <Dropdown
      open={open}
      onOpenChange={onOpenChange}
      trigger={['click']}
      placement="bottomRight"
      // Sous 768 px, le panneau est ramené à la largeur de l'écran par `globals.css` : aligné
      // sur la cloche (bord droit à 288 px sur un 360), ses 360 px partaient sinon 56 px hors
      // de l'écran À GAUCHE — `autoAdjustOverflow` d'AntD bascule le placement mais ne traite
      // pas le cas « plus large que la fenêtre ». Le débordement d'un popup ne fait pas défiler
      // la page : il coupe le contenu en silence.
      rootClassName="da-notif-dropdown"
      popupRender={() => panel}
    >
      <Tooltip title="Notifications">
        <Badge count={unread} size="small" offset={[-2, 2]}>
          <Button
            type="text"
            aria-label="Notifications"
            icon={<icons.notifications size={19} strokeWidth={1.75} />}
          />
        </Badge>
      </Tooltip>
    </Dropdown>
  );
}
