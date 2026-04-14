import { redirect } from "next/navigation";

export default function DashboardIndex() {
  redirect("/get-daily-new-customers-for-cities");
}
