import React from "react";
export function AppIcon({
  name,
}: {
  name: "brand" | "github" | "docs" | "previous" | "play" | "pause" | "next";
}) {
  return (
    <svg
      className={`app-icon icon-${name}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {name === "brand" ? (
        <>
          <rect
            className="brand-icon-background"
            x="1"
            y="1"
            width="22"
            height="22"
            rx="6"
            stroke="none"
          />
          <path d="M6 8h12 M9 8v10 M15 8v8q0 2 3 2" />
          <circle cx="18" cy="5" r="1.5" fill="currentColor" stroke="none" />
        </>
      ) : name === "previous" ? (
        <>
          <path d="M6 5v14" />
          <path d="m18 5-10 7 10 7Z" fill="currentColor" stroke="none" />
        </>
      ) : name === "next" ? (
        <>
          <path d="M18 5v14" />
          <path d="m6 5 10 7-10 7Z" fill="currentColor" stroke="none" />
        </>
      ) : name === "play" ? (
        <path d="m8 4 12 8-12 8Z" fill="currentColor" stroke="none" />
      ) : name === "pause" ? (
        <>
          <rect
            x="6"
            y="4"
            width="4"
            height="16"
            rx="1"
            fill="currentColor"
            stroke="none"
          />
          <rect
            x="14"
            y="4"
            width="4"
            height="16"
            rx="1"
            fill="currentColor"
            stroke="none"
          />
        </>
      ) : name === "docs" ? (
        <>
          <path d="M12 5c-3-2-6-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1Z M12 5v15 M6 8l3 1 M15 9l3-1" />
        </>
      ) : (
        <>
          <path d="M9 20c-4 1-4-2-6-2 M9 23v-4c0-1 .3-1.5 1-2-4-.5-6-2-6-5 0-1.5.5-2.5 1.5-3.5C5 7 5 6 5.5 5c2 0 3 1 4 1.5a10 10 0 0 1 5 0C16 5.5 17 5 18.5 5c.5 1 .5 2 0 3.5C19.5 9.5 20 10.5 20 12c0 3-2 4.5-6 5 .7.5 1 1 1 2v4" />
        </>
      )}
    </svg>
  );
}
