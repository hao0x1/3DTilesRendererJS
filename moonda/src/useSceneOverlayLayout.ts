import { useLayoutEffect } from 'react';
import type { RefObject } from 'react';

/** Reserve the actual header and wrapping control dock, including after resize. */
export default function useSceneOverlayLayout(ref: RefObject<HTMLElement | null>, enabled: boolean) {
  useLayoutEffect(() => {
    const viewer = ref.current;
    if (!viewer || !enabled) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const bounds = viewer.getBoundingClientRect();
      const header = viewer.querySelector<HTMLElement>('.scene-header');
      const dock = viewer.querySelector<HTMLElement>('.scene-controls-dock');
      const headerRect = header?.getClientRects().length ? header.getBoundingClientRect() : null;
      const dockRect = dock?.getClientRects().length ? dock.getBoundingClientRect() : null;
      const top = headerRect ? Math.max(16, headerRect.bottom - bounds.top + 14) : 20;
      const bottom = dockRect ? Math.max(20, bounds.bottom - dockRect.top + 14) : 90;
      viewer.style.setProperty('--scene-overlay-top', `${top}px`);
      viewer.style.setProperty('--scene-overlay-height', `${Math.max(0, bounds.height - top - bottom)}px`);
      viewer.dataset.sceneShort = String(bounds.height < 400);
      viewer.dispatchEvent(new Event('moonda:scene-layout'));
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    const observer = new ResizeObserver(schedule);
    observer.observe(viewer);
    let watched: Element[] = [];
    const bind = () => {
      for (const element of watched) observer.unobserve(element);
      watched = Array.from(viewer.querySelectorAll('.scene-header, .scene-controls-dock'));
      for (const element of watched) observer.observe(element);
      schedule();
    };
    // Retry can replace the renderer's dock without resizing the viewer.
    // Ignore text/caption updates; only structural HUD replacements rebind.
    const structure = new MutationObserver(records => {
      if (records.some(record => [...record.addedNodes, ...record.removedNodes].some(node =>
        node instanceof Element && (node.matches('.scene-header, .scene-controls-dock') || node.querySelector('.scene-header, .scene-controls-dock'))))) bind();
    });
    structure.observe(viewer, { childList: true, subtree: true });
    measure();
    bind();
    return () => { observer.disconnect(); structure.disconnect(); cancelAnimationFrame(frame); };
  }, [ref, enabled]);
}
