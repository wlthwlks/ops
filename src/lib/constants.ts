export const CITIES = [
  "Los Angeles",
  "San Diego",
  "New York",
  "Chicago",
  "Denver",
  "London",
  "Melbourne",
  "Sydney",
  "Atlanta",
  "Dubai",
] as const;

export type City = (typeof CITIES)[number];
