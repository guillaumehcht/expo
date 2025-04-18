// Copyright 2025-present 650 Industries. All rights reserved.

import ExpoModulesCore
import SwiftUI
import MapKit

struct Coordinate: Record {
  @Field var latitude: Double = 0
  @Field var longitude: Double = 0
}

struct MapMarker: Identifiable, Record {
  @Field var id: String = UUID().uuidString
  @Field var coordinates: Coordinate
  @Field var systemImage: String = ""
  @Field var tintColor: Color = .red
  @Field var title: String = ""

  var clLocationCoordinate2D: CLLocationCoordinate2D {
    CLLocationCoordinate2D(
      latitude: coordinates.latitude,
      longitude: coordinates.longitude
    )
  }

  var mkPlacemark: MKPlacemark {
    MKPlacemark(coordinate: clLocationCoordinate2D)
  }

  var mapItem: MKMapItem {
    MKMapItem(placemark: mkPlacemark)
  }
}

struct CameraPosition: Record, Equatable {
  @Field var coordinates: Coordinate
  @Field var zoom: Double = 1

  static func == (lhs: CameraPosition, rhs: CameraPosition) -> Bool {
    return lhs.coordinates.latitude == rhs.coordinates.latitude &&
    lhs.coordinates.longitude == rhs.coordinates.longitude &&
    lhs.zoom == rhs.zoom
  }
}

struct MapAnnotation: Record, Identifiable {
  @Field var id: String = UUID().uuidString
  @Field var coordinates: Coordinate
  @Field var title: String = ""
  @Field var backgroundColor: Color = .white
  @Field var textColor: Color = .black
  @Field var text: String = ""
  @Field var icon: SharedRef<UIImage>?

  var clLocationCoordinate2D: CLLocationCoordinate2D {
    CLLocationCoordinate2D(
      latitude: coordinates.latitude,
      longitude: coordinates.longitude
    )
  }
}

struct MapUISettings: Record {
  @Field var compassEnabled: Bool = true
  @Field var myLocationButtonEnabled: Bool = true
  @Field var scaleBarEnabled: Bool = false
  @Field var togglePitchEnabled: Bool = true
}

struct MapProperties: Record {
  @Field var mapType: MapType = .standard
  @Field var isTrafficEnabled: Bool = false
  @Field var isPointsOfInterestEnabled: Bool = true
  @Field var selectionEnabled: Bool = true
}

enum MapType: String, Enumerable {
  case standard = "STANDARD"
  case mutedStandard = "MUTED_STANDARD"
  case hybrid = "HYBRID"
  case imagery = "IMAGERY"

  @available(iOS 17.0, *)
  func toMapStyle(showsTraffic: Bool = false, pointsOfInterest: Bool = true) -> MapStyle {
    switch self {
    case .standard:
      return .standard(pointsOfInterest: pointsOfInterest, showsTraffic: showsTraffic)
    case .mutedStandard:
      return .mutedStandard(pointsOfInterest: pointsOfInterest, showsTraffic: showsTraffic)
    case .hybrid:
      return .hybrid(pointsOfInterest: pointsOfInterest, showsTraffic: showsTraffic)
    case .imagery:
      return .imagery
    }
  }
}
