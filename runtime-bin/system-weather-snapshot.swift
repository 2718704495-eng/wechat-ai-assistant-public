import Foundation
import CoreLocation
import WeatherKit

struct SystemWeatherSnapshot: Codable {
  let version: Int
  let locationId: String
  let observedAt: String
  let eventDate: String
  let conditionCode: String
  let temperatureC: Double
  let highC: Double
  let lowC: Double
  let precipitationChance: Double
}

func fail() -> Never {
  FileHandle.standardError.write(Data("SYSTEM_WEATHER_SNAPSHOT_FAILED\n".utf8))
  Foundation.exit(1)
}

guard CommandLine.arguments.count == 1 else { fail() }
let semaphore = DispatchSemaphore(value: 0)
Task {
  defer { semaphore.signal() }
  do {
    let location = CLLocation(latitude: 32.0985, longitude: 118.90434)
    let weather = try await WeatherService.shared.weather(
      for: location,
      including: .current, .daily
    )
    guard let day = weather.1.forecast.first else { fail() }
    let conditionBytes = try JSONEncoder().encode(day.condition)
    let conditionCode = try JSONDecoder().decode(String.self, from: conditionBytes)
    let dateFormatter = DateFormatter()
    dateFormatter.calendar = Calendar(identifier: .gregorian)
    dateFormatter.locale = Locale(identifier: "en_US_POSIX")
    dateFormatter.timeZone = TimeZone(identifier: "Asia/Shanghai")
    dateFormatter.dateFormat = "yyyy-MM-dd"
    let iso = ISO8601DateFormatter()
    iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let snapshot = SystemWeatherSnapshot(
      version: 1,
      locationId: "nanjing-qixia-government",
      observedAt: iso.string(from: weather.0.date),
      eventDate: dateFormatter.string(from: day.date),
      conditionCode: conditionCode,
      temperatureC: weather.0.temperature.converted(to: .celsius).value,
      highC: day.highTemperature.converted(to: .celsius).value,
      lowC: day.lowTemperature.converted(to: .celsius).value,
      precipitationChance: day.precipitationChance
    )
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    let bytes = try encoder.encode(snapshot)
    guard bytes.count <= 4095 else { fail() }
    FileHandle.standardOutput.write(bytes)
    FileHandle.standardOutput.write(Data("\n".utf8))
  } catch {
    fail()
  }
}
semaphore.wait()
