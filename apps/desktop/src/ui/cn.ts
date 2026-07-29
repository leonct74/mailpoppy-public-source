import { clsx, type ClassValue } from "clsx";

/** Tiny className combiner (clsx). */
export const cn = (...inputs: ClassValue[]) => clsx(inputs);
