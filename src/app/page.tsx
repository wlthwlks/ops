import { redirect } from "next/navigation";

export default function Home() {
  redirect("/get-daily-new-customers-for-cities");
}
