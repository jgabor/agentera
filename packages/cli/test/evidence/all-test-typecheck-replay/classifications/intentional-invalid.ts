type PackageContract = { version: string };
const negativeFixture: PackageContract = { version: "3.0.0", unexpected: "1.0.0" };
void negativeFixture;
