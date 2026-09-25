import type { Response } from 'express';

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasMore: boolean;
}

export function pageMeta(page: number, pageSize: number, total: number): PageMeta {
  const totalPages = total === 0 ? 0 : Math.ceil(total / pageSize);
  return { page, pageSize, total, totalPages, hasMore: page < totalPages };
}

/** 200 OK with the standard success envelope. */
export function ok<T>(res: Response, data: T, meta?: Record<string, unknown>): void {
  res.status(200).json(meta ? { success: true, data, meta } : { success: true, data });
}

/** 201 Created with the standard success envelope. */
export function created<T>(res: Response, data: T): void {
  res.status(201).json({ success: true, data });
}

/** Paginated list response: `data` is the page of items, `meta` carries paging info. */
export function paged<T>(
  res: Response,
  items: T[],
  page: { page: number; pageSize: number; total: number },
  extra?: Record<string, unknown>,
): void {
  res.status(200).json({
    success: true,
    data: items,
    meta: { ...pageMeta(page.page, page.pageSize, page.total), ...(extra ?? {}) },
  });
}

export function noContent(res: Response): void {
  res.status(204).end();
}
