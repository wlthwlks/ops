export interface CityGroup {
  label: string;
  alternatives: string[];
}

export const CITIES: CityGroup[] = [
  {
    label: "Los Angeles",
    alternatives: ["Los Ángeles", "Pasadena", "Santa Barbara", "Los Angeles"],
  },
  {
    label: "San Diego",
    alternatives: ["San Diego Metro", "Encinitas", "Escondido", "San Diego", "Temecula Valley", "Escondido"],
  },
  {
    label: "New York",
    alternatives: ["NYC", "NY", "New York City", "New York"],
  },
  {
    label: "Chicago",
    alternatives: ["Chicago"],
  },
  {
    label: "Denver",
    alternatives: ["Denver", "Front Range", "Boulder", "Arvada", "arvada", "Littleton", "Parker", "Colorado Springs"],
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
  {
    label: "Miami",
    alternatives: ["Miami","Miami Metro", "Miami Beach", "Fort Lauderdale", "Boca Raton","Delray Beach","Palm Beach"],
  },
  {
    label: "Dallas",
    alternatives: ["Dallas", "Dallas Metro","Forth Worth"],
  },
   {
    label: "Brisbane",
    alternatives: ["Brisbane", "Gold Coast", "Sunshine Coast"],
  },
   {
    label: "San Francisco",
    alternatives: ["San Francisco","San Francisco Bay Area","Palo Alto", "Sausalito","San Rafael"],
  },
   {
    label: "Chicago",
    alternatives: ["Chicago"],
  },
  {
    label: "Portland",
    alternatives: ["Portland"]
  },
  {
    label: "Tampa",
    alternatives: ["Tampa", "Tampa Bay","St Petersburg"]
  },
  {
    label: "Phoenix",
    alternatives: ["Phoenix", "Phoenix Metro","Scottsdale", "Gilbert"]
  },
  {
    label: "Washington DC",
    alternatives: ["Washington","Washington DC","Washington DC Metro", "McLean VA"]
  },
  {
    label: "Cape Town",
    alternatives: ["Cape Town"]
  },
  { label: "Toronto", alternatives: ["Toronto"]},
  { label: "Charlotte", alternatives: ["Charlotte"] },
  { label: "Detroit", alternatives: ["Detroit"] },
  { label: "Las Vegas", alternatives: ["Las Vegas", "Las Vegas Metro", "Boulder City"] },
  { label: "Vancouver", alternatives: ["Vancouver", "Surrey/Vancouver"] },
  { label: "Seattle", alternatives: ["Seattle", "Issaquah"] },
  { label: "Nashville", alternatives: ["Nashville"] },
  { label: "Boston", alternatives: ["Boston"]},
]
