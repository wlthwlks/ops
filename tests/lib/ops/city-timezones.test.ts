import { describe, it, expect } from "vitest";
import { CITY_TIMEZONES } from "@/lib/ops/city-timezones";

/** Every city name present in city_introduction_settings (prod snapshot). */
const ALL_CITY_NAMES = [
  "Abu Dhabi", "Adelaide", "Akron", "Algonac", "Arvada", "Asheville", "Atlanta",
  "Austin", "Bangalore", "Barcelona", "Bellevue Hill", "Berkeley", "Berlin",
  "Blue Springs", "Boca Raton", "Boston", "Boulder", "Boulder City",
  "Boynton Beach", "Brisbane", "Brooklyn", "Buenos Aires", "Burlington",
  "Burlington, Ontario", "Burnaby", "Byron Bay", "Cairns", "Camas", "Cape Town",
  "Carlsbad", "Charleston", "Charlotte", "Chelsea", "Chicago", "Cincinnati",
  "Cleveland", "Colorado Springs", "Columbus", "Da Nang", "Dallas", "Davidson",
  "Delray Beach", "Denver", "Detroit", "Devon", "Doha", "Doylestown", "Drogheda",
  "Dubai", "Dublin", "Edinburgh", "Elizabeth", "Encinitas", "Escondido",
  "Etobicoke", "Euless", "Fairfax", "Florence", "Fort Lauderdale", "Fort Worth",
  "Gilbert", "Glen Allen", "Gold Coast", "Henderson", "Hobart", "Honolulu",
  "Hope Island", "Houston", "Hudson", "Huntington Beach", "Indianapolis",
  "Issaquah", "Jacksonville", "Juneau", "Kansas City", "Kuala Lumpur", "Lagos",
  "Laguna Beach", "Lancaster", "Lane Cove", "Las Vegas", "Lauderdale-by-the-Sea",
  "Lawrenceville", "Lisbon", "Littleton", "London", "Long Island", "Los Angeles",
  "Los Gatos", "Louisville", "Madison", "Maidstone", "McAllen", "McLean VA",
  "Melbourne", "Memphis", "Menlo Park", "Mexico City", "Miami", "Miami Beach",
  "Minneapolis", "Mississauga", "Montréal", "Nashville", "New York",
  "Newport Beach", "Nuremberg", "Oakland", "Oakville", "Oceanside",
  "Orange County", "Orange Park", "Orlando", "Palm Beach", "Palm Beach Gardens",
  "Palm Springs", "Palo Alto", "Paris", "Parker", "Pasadena", "Perth",
  "Philadelphia", "Phoenix", "Phu Quoc", "Pittsburgh", "Ponte Vedra Beach",
  "Portland", "Pulaski", "Raleigh", "Redondo Beach", "Richmond", "Richmond Hill",
  "Robina", "Sacramento", "Salt Lake City", "San Antonio", "San Diego",
  "San Francisco", "San Luis Obispo", "San Rafael", "Santa Barbara", "Sarasota",
  "Savannah", "Scottsdale", "Seal Beach", "Seattle", "Singapore", "Spokane",
  "St Albans", "St. Louis", "St. Petersburg", "Stellenbosch", "Summerville",
  "Sunnyvale", "Sunshine Coast", "Surrey", "Surrey/Vancouver", "Sydney",
  "São Paulo", "Tampa", "Temecula Valley", "Tokyo", "Toronto", "Tucson", "Uki",
  "Vacaville", "València", "Vancouver", "Venice", "Virtual", "Waco",
  "Washington, D.C.", "Westminster, VA", "Whitby", "Windsor", "Windsor, UK",
  "Woodland Hills",
];

function isValidIanaZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

describe("CITY_TIMEZONES", () => {
  it("covers every city name in city_introduction_settings", () => {
    const missing = ALL_CITY_NAMES.filter((name) => !CITY_TIMEZONES[name]);
    expect(missing).toEqual([]);
  });

  it("maps every value to a valid IANA timezone", () => {
    for (const [city, zone] of Object.entries(CITY_TIMEZONES)) {
      expect(isValidIanaZone(zone), `${city} → ${zone}`).toBe(true);
    }
  });

  it("keeps well-known city zones", () => {
    expect(CITY_TIMEZONES["New York"]).toBe("America/New_York");
    expect(CITY_TIMEZONES["Los Angeles"]).toBe("America/Los_Angeles");
    expect(CITY_TIMEZONES["Chicago"]).toBe("America/Chicago");
    expect(CITY_TIMEZONES["Denver"]).toBe("America/Denver");
    expect(CITY_TIMEZONES["Phoenix"]).toBe("America/Phoenix");
    expect(CITY_TIMEZONES["London"]).toBe("Europe/London");
    expect(CITY_TIMEZONES["Sydney"]).toBe("Australia/Sydney");
    expect(CITY_TIMEZONES["Lancaster"]).toBe("America/New_York");
    expect(CITY_TIMEZONES["Windsor"]).toBe("America/Toronto");
    expect(CITY_TIMEZONES["Windsor, UK"]).toBe("Europe/London");
  });
});
