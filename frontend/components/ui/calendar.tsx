"use client"

import * as React from "react"
import { DayPicker } from "react-day-picker"
import "react-day-picker/style.css"

import { cn } from "@/lib/utils"

const plFormatters = {
  formatCaption: (date: Date) =>
    new Intl.DateTimeFormat("pl-PL", { month: "long", year: "numeric" }).format(date),
  formatWeekdayName: (date: Date) =>
    new Intl.DateTimeFormat("pl-PL", { weekday: "short" }).format(date),
}

export function Calendar({ className, ...props }: React.ComponentProps<typeof DayPicker>) {
  return (
    <DayPicker
      weekStartsOn={1}
      formatters={plFormatters}
      className={cn("rdp-dark p-3", className)}
      {...props}
    />
  )
}
