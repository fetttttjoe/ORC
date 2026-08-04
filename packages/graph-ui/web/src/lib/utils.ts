import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export const cn = (...inputs: ClassValue[]): string => twMerge(clsx(inputs))

// shadcn-svelte vendored components thread a bindable element ref through this helper type
export type WithElementRef<T, U extends HTMLElement = HTMLElement> = T & { ref?: U | null }
