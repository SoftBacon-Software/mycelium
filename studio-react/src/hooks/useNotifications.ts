import { useCallback, useEffect, useRef, useState } from 'react';
import { useDashboardStore } from '../stores/dashboardStore';

export function useNotifications() {
  const [permission, setPermission] = useState<NotificationPermission>(
    typeof Notification !== 'undefined' ? Notification.permission : 'default',
  );

  const messages = useDashboardStore((s) => s.messages);
  const tasks = useDashboardStore((s) => s.tasks);

  // Track previous counts to detect new items
  const prevMessageCount = useRef(messages.length);
  const prevTaskCount = useRef(
    tasks.open.length + tasks.in_progress.length + tasks.review.length,
  );

  const requestPermission = useCallback(async () => {
    if (typeof Notification === 'undefined') return;
    const result = await Notification.requestPermission();
    setPermission(result);
  }, []);

  // Request permission on mount if not yet decided
  useEffect(() => {
    if (permission === 'default') {
      requestPermission();
    }
  }, [permission, requestPermission]);

  // Watch for new messages
  useEffect(() => {
    if (permission !== 'granted') return;

    const newCount = messages.length;
    if (prevMessageCount.current > 0 && newCount > prevMessageCount.current) {
      const diff = newCount - prevMessageCount.current;
      new Notification('Mycelium Studio', {
        body: `${diff} new message${diff > 1 ? 's' : ''} received`,
        tag: 'mycelium-messages',
      });
    }
    prevMessageCount.current = newCount;
  }, [messages, permission]);

  // Watch for new tasks
  useEffect(() => {
    if (permission !== 'granted') return;

    const currentCount =
      tasks.open.length + tasks.in_progress.length + tasks.review.length;
    if (prevTaskCount.current > 0 && currentCount > prevTaskCount.current) {
      const diff = currentCount - prevTaskCount.current;
      new Notification('Mycelium Studio', {
        body: `${diff} new task${diff > 1 ? 's' : ''} added`,
        tag: 'mycelium-tasks',
      });
    }
    prevTaskCount.current = currentCount;
  }, [tasks, permission]);

  return { permission, requestPermission };
}
