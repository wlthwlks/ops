export interface CityGroup {
  label: string;
  alternatives: string[];
}

export const CITIES: CityGroup[] = [
  {
    label: "Los Angeles",
    alternatives: ["LA", "Los Ángeles", "Pasadena", "Santa Barbara", "Temecula Valley", "SoCal", "Beverly Hills", "Hollywood", "Burbank", "Glendale"],
  },
  {
    label: "San Diego",
    alternatives: ["San Diego Metro", "Encinitas", "Encinitas", "Escondido"],
  },
  {
    label: "New York",
    alternatives: ["NYC", "NY", "New York City"],
  },
  {
    label: "Chicago",
    alternatives: ["Chicago"],
  },
  {
    label: "Denver",
    alternatives: ["Denver/Front Range", "Boulder", "Arvada", "Littleton", "Parker", "Colorado Springs"],
  },
  {
    label: "London",
    alternatives: ["Greater London", "St Albans", "Maidstone"],
  },
  {
    label: "Melbourne",
    alternatives: ["Melbourne"],
  },
  {
    label: "Sydney",
    alternatives: ["Sydney"],
  },
  {
    label: "Atlanta",
    alternatives: ["Atlanta"],
  },
  {
    label: "Dubai",
    alternatives: ["Dubai"],
  },
];
